//! End-to-end against a real Node host: the Rust engine and the coordinator
//! (pinomad-core) open a DataChannel to node-datachannel, run Noise IK over
//! it, and receive the host's business hello. The host is spawned with a
//! throwaway data dir and STUN disabled, so the test uses loopback candidates
//! only and never touches the network beyond the loopback addresses. The
//! client binds both loopback families when IPv6 is available, exercising the
//! dual-stack socket routing without requiring a public IPv6 address.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcCommand, Stdio};
use std::time::{Duration, Instant};

use pinomad_core::b64::to_base64url;
use pinomad_core::connection_mode::ConnectionMode;
use pinomad_core::json::Json;
use pinomad_core::pairing_link::parse_pairing_link;
use pinomad_core::remote_candidates::candidate_plan;
use pinomad_core::remote_durable::{
    Call, CandidateTimeouts, Command, Event, ReadyOutcome, RemoteDurable, RemoteDurableOptions,
    RemoteMode, RtcOptions, RtcSendOutcome,
};
use pinomad_core::secure_channel::{Pairing, SecureTransport};
use pinomad_core::transport::PlaintextTransport;
use pinomad_rtc::{Action, Engine, EngineConfig, SendOutcome};
use tungstenite::{Message, WebSocket};

struct SpawnedHost {
    child: Child,
    url: String,
    token: String,
    _dir: TempDataDir,
}

struct TempDataDir(PathBuf);

impl TempDataDir {
    fn new() -> Self {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "pinomad-rtc-interop-{}-{}-{}",
            std::process::id(),
            now_ms(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDataDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let mut lock = self.0.as_os_str().to_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_dir_all(PathBuf::from(lock));
    }
}

impl Drop for SpawnedHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

fn spawn_host() -> SpawnedHost {
    let dir = TempDataDir::new();
    std::fs::write(dir.path().join("settings.json"), br#"{"rtcStun":[]}"#).unwrap();
    let port = free_port();
    let child = ProcCommand::new("node")
        .arg("apps/host/src/main.ts")
        .arg("--data-dir")
        .arg(dir.path())
        .arg("--port")
        .arg(port.to_string())
        .arg("--faux")
        .arg("rtc interop")
        .current_dir(repo_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn node host");
    let mut host = SpawnedHost {
        child,
        url: String::new(),
        token: String::new(),
        _dir: dir,
    };
    let stdout = host.child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut ready = None;
    while Instant::now() < deadline {
        let mut line = String::new();
        match lines.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.contains("\"event\":\"ready\"") || line.contains("\"event\": \"ready\"") {
                    ready = Some(line.trim().to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let ready = ready.expect("host did not print a ready line");
    let parsed = serde_json::from_str::<serde_json::Value>(&ready).expect("ready line JSON");
    let token_file = parsed["tokenFile"].as_str().expect("tokenFile");
    host.token = std::fs::read_to_string(token_file)
        .expect("read token file")
        .trim()
        .to_string();
    host.url = parsed["url"].as_str().expect("url").to_string();
    host
}

/// Minimal admin/pairing driver: opens Websockets, sends bytes, feeds inbound
/// frames back. No RTC.
struct SocketDriver {
    remote: RemoteDurable,
    sockets: HashMap<u32, WebSocket<TcpStream>>,
    pending: std::collections::VecDeque<Command>,
    ready: Option<ReadyOutcome>,
    ops: HashMap<u64, Result<Option<Json>, String>>,
    paired: Option<String>,
}

impl SocketDriver {
    fn new(remote: RemoteDurable) -> Self {
        let mut driver = SocketDriver {
            remote,
            sockets: HashMap::new(),
            pending: std::collections::VecDeque::new(),
            ready: None,
            ops: HashMap::new(),
            paired: None,
        };
        let initial = driver.remote.take();
        driver.pump(initial);
        driver
    }

    fn pump(&mut self, commands: Vec<Command>) {
        self.pending.extend(commands);
        while let Some(command) = self.pending.pop_front() {
            match command {
                Command::OpenConnection { conn, url } => {
                    let request = tungstenite::client::IntoClientRequest::into_client_request(&url)
                        .expect("ws url");
                    let host = request.uri().host().unwrap().to_string();
                    let port = request.uri().port_u16().unwrap_or(80);
                    let stream = TcpStream::connect((host.as_str(), port)).expect("tcp connect");
                    let socket = tungstenite::client(request, stream)
                        .expect("ws handshake")
                        .0;
                    self.sockets.insert(conn, socket);
                    let more = self.remote.handle(Event::SocketOpened { conn });
                    self.pump(more);
                    self.read(conn);
                }
                Command::SendBytes { conn, bytes } => {
                    let message = match String::from_utf8(bytes.clone()) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => Message::Binary(bytes.into()),
                    };
                    self.sockets
                        .get_mut(&conn)
                        .expect("send on live conn")
                        .send(message)
                        .expect("ws send");
                    self.read(conn);
                }
                Command::CloseSocket { conn } => {
                    if let Some(mut socket) = self.sockets.remove(&conn) {
                        let _ = socket.close(None);
                    }
                    let more = self.remote.handle(Event::SocketClosed {
                        conn,
                        code: 1000,
                        reason: None,
                    });
                    self.pump(more);
                }
                Command::ScheduleReconnect { timer, delay_ms } => {
                    std::thread::sleep(Duration::from_millis(delay_ms.min(100)));
                    let more = self.remote.handle(Event::TimerFired { timer });
                    self.pump(more);
                }
                Command::ScheduleDeadline { .. } | Command::CancelDeadline { .. } => {}
                Command::CancelReconnect { .. } => {}
                Command::Ready { outcome } => self.ready = Some(outcome),
                Command::Paired { private_key, .. } => self.paired = Some(private_key),
                Command::OperationSucceeded { op, value } => {
                    self.ops.insert(op, Ok(value));
                }
                Command::OperationFailed { op, error, .. } => {
                    self.ops.insert(op, Err(error));
                }
                Command::ViewChanged
                | Command::CandidateFailed { .. }
                | Command::EndpointSet { .. }
                | Command::RtcSignalOnly { .. }
                | Command::CreateRtcPeer { .. }
                | Command::AcceptRtcAnswer { .. }
                | Command::RtcSend { .. }
                | Command::CloseRtcPeer { .. } => {}
            }
        }
    }

    fn read(&mut self, conn: u32) {
        let mut events = Vec::new();
        if let Some(socket) = self.sockets.get_mut(&conn) {
            socket.get_mut().set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_millis(100);
            loop {
                match socket.read() {
                    Ok(Message::Text(text)) => events.push(Event::SocketData {
                        conn,
                        bytes: text.as_bytes().to_vec(),
                    }),
                    Ok(Message::Binary(bytes)) => events.push(Event::SocketData {
                        conn,
                        bytes: bytes.to_vec(),
                    }),
                    Ok(Message::Close(frame)) => {
                        let code = frame.as_ref().map(|f| f.code.into()).unwrap_or(1000);
                        let reason = frame.map(|f| f.reason.to_string());
                        events.push(Event::SocketClosed { conn, code, reason });
                        break;
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(error))
                        if error.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        if Instant::now() > deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("ws error: {error:?}"),
                }
            }
            socket.get_mut().set_nonblocking(false).unwrap();
        }
        for event in events {
            let more = self.remote.handle(event);
            self.pending.extend(more);
        }
        self.pump(Vec::new());
    }

    fn wait(&mut self, budget: Duration, pred: impl Fn(&Self) -> bool) {
        let start = Instant::now();
        while !pred(self) {
            assert!(
                start.elapsed() < budget,
                "timed out waiting for the socket driver"
            );
            let conns: Vec<u32> = self.sockets.keys().copied().collect();
            for conn in conns {
                self.read(conn);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn invoke(&mut self, op: u64, call: Call) {
        let commands = self.remote.handle(Event::Invoke { op, call });
        self.pump(commands);
    }
}

struct Peer {
    engine: Engine,
    /// One socket per local address, keyed by the address the engine uses as
    /// the transmit source.
    sockets: Vec<(SocketAddr, UdpSocket)>,
    peer: u32,
    next_deadline: Option<u64>,
}

struct RtcDriver {
    remote: RemoteDurable,
    socket: Option<WebSocket<TcpStream>>,
    conn: u32,
    peer: Option<Peer>,
    deadlines: HashMap<u32, u64>,
    base: Instant,
}

impl RtcDriver {
    fn new(mut remote: RemoteDurable) -> Self {
        let initial = remote.take();
        let mut driver = RtcDriver {
            remote,
            socket: None,
            conn: 0,
            peer: None,
            deadlines: HashMap::new(),
            base: Instant::now(),
        };
        driver.pump(initial);
        driver
    }

    fn now(&self) -> u64 {
        self.base.elapsed().as_millis() as u64
    }

    fn pump(&mut self, commands: Vec<Command>) {
        for command in commands {
            match command {
                Command::OpenConnection { conn, url } => {
                    let request = tungstenite::client::IntoClientRequest::into_client_request(&url)
                        .expect("ws url");
                    let host = request.uri().host().unwrap().to_string();
                    let port = request.uri().port_u16().unwrap_or(80);
                    let stream = TcpStream::connect((host.as_str(), port)).expect("tcp connect");
                    let socket = tungstenite::client(request, stream)
                        .expect("ws handshake")
                        .0;
                    self.socket = Some(socket);
                    self.conn = conn;
                    let more = self.remote.handle(Event::SocketOpened { conn });
                    self.pump(more);
                    self.read_socket();
                }
                Command::SendBytes { conn: _, bytes } => {
                    let message = match String::from_utf8(bytes.clone()) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => Message::Binary(bytes.into()),
                    };
                    self.socket
                        .as_mut()
                        .expect("send on a live socket")
                        .send(message)
                        .expect("ws send");
                    self.read_socket();
                }
                Command::CloseSocket { conn } => {
                    self.socket = None;
                    let more = self.remote.handle(Event::SocketClosed {
                        conn,
                        code: 1000,
                        reason: None,
                    });
                    self.pump(more);
                }
                Command::ScheduleReconnect { timer, delay_ms } => {
                    self.deadlines.insert(timer, self.now() + delay_ms);
                }
                Command::CancelReconnect { timer } => {
                    self.deadlines.remove(&timer);
                }
                Command::ScheduleDeadline { timer, delay_ms } => {
                    self.deadlines.insert(timer, self.now() + delay_ms);
                }
                Command::CancelDeadline { timer } => {
                    self.deadlines.remove(&timer);
                }
                Command::CreateRtcPeer { peer, stun } => {
                    assert!(
                        stun.is_empty(),
                        "the test host must advertise no STUN: {stun:?}"
                    );
                    let mut sockets = Vec::new();
                    let mut locals = Vec::new();
                    for bind in ["0.0.0.0:0", "[::]:0"] {
                        let Ok(socket) = UdpSocket::bind(bind) else {
                            continue;
                        };
                        socket.set_nonblocking(true).unwrap();
                        let port = socket.local_addr().unwrap().port();
                        let local: SocketAddr = if bind.starts_with('[') {
                            format!("[::1]:{port}").parse().unwrap()
                        } else {
                            format!("127.0.0.1:{port}").parse().unwrap()
                        };
                        sockets.push((local, socket));
                        locals.push(local);
                    }
                    assert!(!sockets.is_empty(), "no loopback UDP socket");
                    let mut engine = Engine::new(
                        EngineConfig {
                            local_addrs: locals,
                            stun_servers: vec![],
                        },
                        self.now(),
                    );
                    let actions = engine.start(self.now());
                    self.peer = Some(Peer {
                        engine,
                        sockets,
                        peer,
                        next_deadline: None,
                    });
                    self.apply(actions);
                }
                Command::AcceptRtcAnswer { peer, sdp } => {
                    let now = self.now();
                    if let Some(runtime) = self.peer.as_mut().filter(|p| p.peer == peer) {
                        let actions = runtime.engine.accept_answer(now, &sdp);
                        self.apply(actions);
                    }
                }
                Command::RtcSend { peer, bytes } => {
                    let now = self.now();
                    let Some(runtime) = self.peer.as_mut().filter(|p| p.peer == peer) else {
                        continue;
                    };
                    let (outcome, actions) = runtime.engine.send(now, &bytes);
                    self.apply(actions);
                    let mapped = match outcome {
                        SendOutcome::Accepted => RtcSendOutcome::Accepted,
                        SendOutcome::Rejected => RtcSendOutcome::Rejected,
                    };
                    let more = self.remote.handle(Event::RtcSendResult {
                        peer,
                        outcome: mapped,
                    });
                    self.pump(more);
                }
                Command::CloseRtcPeer { peer } => {
                    if let Some(mut runtime) = self.peer.take().filter(|p| p.peer == peer) {
                        runtime.engine.close();
                    }
                }
                Command::RtcSignalOnly { .. }
                | Command::CandidateFailed { .. }
                | Command::EndpointSet { .. }
                | Command::ViewChanged
                | Command::Ready { .. }
                | Command::Paired { .. }
                | Command::OperationSucceeded { .. }
                | Command::OperationFailed { .. } => {}
            }
        }
    }

    fn apply(&mut self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Transmit {
                    source,
                    destination,
                    bytes,
                } => {
                    if let Some(runtime) = self.peer.as_ref() {
                        let socket = runtime
                            .sockets
                            .iter()
                            .find(|(local, _)| *local == source)
                            .map(|(_, socket)| socket);
                        assert!(
                            socket.is_some(),
                            "no socket bound to transmit source {source}"
                        );
                        let _ = socket.unwrap().send_to(&bytes, destination);
                    }
                }
                Action::Schedule { at_ms } => {
                    if let Some(runtime) = self.peer.as_mut() {
                        runtime.next_deadline = Some(at_ms);
                    }
                }
                Action::LocalOffer { sdp } => {
                    let peer = self.peer.as_ref().unwrap().peer;
                    let more = self.remote.handle(Event::RtcPeerReady { peer, sdp });
                    self.pump(more);
                }
                Action::ChannelOpened => {
                    let peer = self.peer.as_ref().unwrap().peer;
                    let more = self.remote.handle(Event::RtcChannelOpened { peer });
                    self.pump(more);
                }
                Action::Data { bytes } => {
                    let peer = self.peer.as_ref().unwrap().peer;
                    let more = self.remote.handle(Event::RtcData { peer, bytes });
                    self.pump(more);
                }
                Action::BufferedAmountLow => {
                    let peer = self.peer.as_ref().unwrap().peer;
                    let more = self.remote.handle(Event::RtcLowWater { peer });
                    self.pump(more);
                }
                Action::SelectedCandidate { local, remote } => {
                    let peer = self.peer.as_ref().unwrap().peer;
                    let more = self.remote.handle(Event::RtcSelectedCandidate {
                        peer,
                        local: pinomad_core::rtc::RtcCandidateInfo {
                            rtc_type: Some(local.kind),
                            address: Some(local.address.to_string()),
                        },
                        remote: pinomad_core::rtc::RtcCandidateInfo {
                            rtc_type: Some(remote.kind),
                            address: Some(remote.address.to_string()),
                        },
                    });
                    self.pump(more);
                }
                Action::Closed { reason } => {
                    let Some(runtime) = self.peer.take() else {
                        continue;
                    };
                    let more = self.remote.handle(Event::RtcClosed {
                        peer: runtime.peer,
                        reason: Some(reason),
                    });
                    self.pump(more);
                }
            }
        }
    }

    fn read_socket(&mut self) {
        let Some(socket) = self.socket.as_mut() else {
            return;
        };
        let mut events = Vec::new();
        socket.get_mut().set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_millis(50);
        loop {
            match socket.read() {
                Ok(Message::Text(text)) => events.push(Event::SocketData {
                    conn: self.conn,
                    bytes: text.as_bytes().to_vec(),
                }),
                Ok(Message::Binary(bytes)) => events.push(Event::SocketData {
                    conn: self.conn,
                    bytes: bytes.to_vec(),
                }),
                Ok(Message::Close(frame)) => {
                    let code = frame.as_ref().map(|f| f.code.into()).unwrap_or(1000);
                    let reason = frame.map(|f| f.reason.to_string());
                    events.push(Event::SocketClosed {
                        conn: self.conn,
                        code,
                        reason,
                    });
                    break;
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if error.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    if Instant::now() > deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("ws error: {error:?}"),
            }
        }
        socket.get_mut().set_nonblocking(false).unwrap();
        for event in events {
            let more = self.remote.handle(event);
            self.pump(more);
        }
    }

    fn poll_udp(&mut self) {
        let mut received = Vec::new();
        if let Some(runtime) = self.peer.as_ref() {
            let mut buffer = [0u8; 65536];
            for (local, socket) in &runtime.sockets {
                loop {
                    match socket.recv_from(&mut buffer) {
                        Ok((count, source)) => {
                            received.push((*local, source, buffer[..count].to_vec()))
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(error) => panic!("udp receive: {error}"),
                    }
                }
            }
        }
        let now = self.now();
        for (local, source, bytes) in received {
            let Some(runtime) = self.peer.as_mut() else {
                break;
            };
            let actions = runtime.engine.receive(now, local, source, &bytes);
            self.apply(actions);
        }
    }

    fn fire_due(&mut self) {
        let now = self.now();
        let due: Vec<u32> = self
            .deadlines
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(timer, _)| *timer)
            .collect();
        for timer in due {
            self.deadlines.remove(&timer);
            let more = self.remote.handle(Event::TimerFired { timer });
            self.pump(more);
        }
        let peer_due = self
            .peer
            .as_ref()
            .and_then(|runtime| runtime.next_deadline)
            .is_some_and(|at| at <= now);
        if peer_due {
            if let Some(runtime) = self.peer.as_mut() {
                runtime.next_deadline = None;
                let actions = runtime.engine.timeout(now);
                self.apply(actions);
            }
        }
    }

    fn wait_path(&mut self, budget: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < budget {
            let now = self.now();
            let clock = self.remote.handle(Event::Clock { now_ms: now });
            self.pump(clock);
            self.read_socket();
            self.poll_udp();
            self.fire_due();
            let path = self
                .remote
                .rtc_diagnostics()
                .get("path")
                .and_then(Json::as_str)
                .map(|s| s.to_string_lossy());
            let connected = self.remote.view().and_then(|view| {
                view.get("connection")
                    .and_then(Json::as_str)
                    .map(|s| s.to_string_lossy())
            });
            if path.as_deref() == Some("p2p") && connected.as_deref() == Some("connected") {
                return true;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        false
    }
}

#[test]
fn engine_reaches_the_business_hello_over_a_real_host() {
    let host = spawn_host();
    let admin_url = format!("{}/?token={}", host.url.trim_end_matches('/'), host.token);
    let mut admin = SocketDriver::new(RemoteDurable::new(RemoteDurableOptions {
        reconnect_delay_ms: None,
        request_id: None,
        ..RemoteDurableOptions::single(Box::new(PlaintextTransport { url: admin_url }))
    }));
    admin.wait(Duration::from_secs(10), |driver| driver.ready.is_some());
    assert_eq!(admin.ready, Some(ReadyOutcome::Connected));
    admin.invoke(1, Call::CreatePairing);
    admin.wait(Duration::from_secs(10), |driver| {
        driver.ops.contains_key(&1)
    });
    let pairing = admin.ops[&1].as_ref().unwrap().as_ref().unwrap();
    let link = pairing
        .get("url")
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .unwrap();
    let parsed = parse_pairing_link(&link).expect("pairing link");

    let device = pinomad_core::noise::generate_keypair().expect("device keypair");
    let device_private = to_base64url(&device.private_key);
    let mut pair = SocketDriver::new(RemoteDurable::new(RemoteDurableOptions {
        reconnect_delay_ms: None,
        request_id: None,
        ..RemoteDurableOptions::single(Box::new(
            SecureTransport::new(
                &parsed.url,
                &to_base64url(&parsed.host_key),
                &device_private,
                Some(Pairing {
                    secret: parsed.secret.clone(),
                    name: "rtc-interop".to_string(),
                }),
            )
            .expect("secure transport"),
        ))
    }));
    pair.wait(Duration::from_secs(15), |driver| {
        driver.ready.is_some() && driver.paired.is_some()
    });
    assert_eq!(pair.ready, Some(ReadyOutcome::Connected));
    let private_key = pair
        .paired
        .clone()
        .expect("the pairing persisted the device key");

    let url = parsed.url.clone();
    let host_key = to_base64url(&parsed.host_key);
    let source = SecureTransport::new(&url, &host_key, &private_key, None).expect("transport");
    let options = RemoteDurableOptions {
        source: Box::new(pinomad_core::remote_durable::SingleSource::new(Box::new(
            source,
        ))),
        mode: RemoteMode::Single,
        reconnect_delay_ms: None,
        request_id: None,
        candidates: candidate_plan(&url, None, None),
        legacy_url: Some(url.clone()),
        page_protocol: None,
        host_key: host_key.clone(),
        pairing_endpoint_set: None,
        candidate_timeouts: CandidateTimeouts::default(),
        round_timeout_ms: None,
        connection_mode: ConnectionMode::DirectOnly,
        rtc: Some(RtcOptions {
            host_key,
            device_private_key: private_key.clone(),
            signal_only_hint: false,
        }),
    };
    let mut rtc = RtcDriver::new(RemoteDurable::new(options));
    assert!(
        rtc.wait_path(Duration::from_secs(40)),
        "the P2P handoff never completed: {}",
        rtc.remote.rtc_diagnostics().to_json()
    );
    let diagnostics = rtc.remote.rtc_diagnostics();
    assert_eq!(
        diagnostics
            .get("path")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .as_deref(),
        Some("p2p")
    );
    let connected = rtc.remote.view().and_then(|view| {
        view.get("connection")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
    });
    assert_eq!(connected.as_deref(), Some("connected"));
}
