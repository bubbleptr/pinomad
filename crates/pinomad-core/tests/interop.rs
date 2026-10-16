// Real-host interoperability: this test spawns `node apps/host/src/main.ts`
// with a throwaway data dir, pairs over createPairing + the Noise IK secure
// channel, and synchronizes a conversation — the mobile client's actual path.
// The WebSocket driver (tungstenite) lives in dev-dependencies only, as does
// every I/O primitive this file uses.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command as ProcCommand, Stdio};
use std::time::{Duration, Instant};

use pinomad_core::b64::to_base64url;
use pinomad_core::json::Json;
use pinomad_core::pairing_link::parse_pairing_link;
use pinomad_core::remote_durable::{Call, Command, Event, ReadyOutcome, RemoteDurable, RemoteDurableOptions};
use pinomad_core::secure_channel::{Pairing, SecureTransport};
use pinomad_core::transport::PlaintextTransport;
use tungstenite::{Message, WebSocket};

struct SpawnedHost {
    child: Child,
    url: String,
    token: String,
    dir: PathBuf,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn spawn_host() -> SpawnedHost {
    let dir = std::env::temp_dir().join(format!("pinomad-interop-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = free_port();
    let mut child = ProcCommand::new("node")
        .arg("apps/host/src/main.ts")
        .arg("--data-dir")
        .arg(&dir)
        .arg("--port")
        .arg(port.to_string())
        .arg("--faux")
        .arg("interop ok")
        .current_dir(repo_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node host");
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut ready = None;
    // Read stdout until the `{"event":"ready",...}` line.
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
    let token = std::fs::read_to_string(token_file).expect("read token file").trim().to_string();
    let url = parsed["url"].as_str().expect("url").to_string();
    SpawnedHost { child, url, token, dir }
}

impl Drop for SpawnedHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

/// The platform side of the event/command loop over a real WebSocket:
/// OpenConnection opens tungstenite, SendBytes writes, incoming messages go
/// back in as SocketData/SocketClosed.
struct Driver {
    remote: RemoteDurable,
    sockets: HashMap<u32, WebSocket<TcpStream>>,
    pending: std::collections::VecDeque<Command>,
    ready: Option<ReadyOutcome>,
    ops: HashMap<u64, Result<Option<Json>, String>>,
    paired: Option<(String, String, String)>,
}

impl Driver {
    fn new(remote: RemoteDurable) -> Self {
        let mut driver = Driver {
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
                    let (socket, _) = {
                        let request = tungstenite::client::IntoClientRequest::into_client_request(&url).expect("ws url");
                        let host = request.uri().host().unwrap().to_string();
                        let port = request.uri().port_u16().unwrap_or(80);
                        let stream = TcpStream::connect((host.as_str(), port)).expect("tcp connect");
                        tungstenite::client(request, stream).expect("ws handshake")
                    };
                    self.sockets.insert(conn, socket);
                    let more = self.remote.handle(Event::SocketOpened { conn });
                    self.pump(more);
                    self.read_socket(conn);
                }
                Command::SendBytes { conn, bytes } => {
                    let message = match String::from_utf8(bytes.clone()) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => Message::Binary(bytes.into()),
                    };
                    match self.sockets.get_mut(&conn) {
                        Some(socket) => socket.send(message).expect("ws send"),
                        None => panic!("SendBytes for missing conn {conn} (closed already?)"),
                    }
                    self.read_socket(conn);
                }
                Command::CloseSocket { conn } => {
                    if let Some(mut socket) = self.sockets.remove(&conn) {
                        let _ = socket.close(None);
                    }
                    let more = self.remote.handle(Event::SocketClosed { conn, code: 1000, reason: None });
                    self.pump(more);
                }
                Command::ScheduleReconnect { timer, delay_ms } => {
                    std::thread::sleep(Duration::from_millis(delay_ms.min(200)));
                    let more = self.remote.handle(Event::TimerFired { timer });
                    self.pump(more);
                }
                // Timers fire synchronously inside pump, so a cancel can
                // only arrive for one already discharged.
                Command::CancelReconnect { .. } => {}
                Command::Ready { outcome } => self.ready = Some(outcome),
                Command::ViewChanged => {}
                Command::Paired { url, host_key, private_key } => {
                    self.paired = Some((url, host_key, private_key));
                }
                Command::OperationSucceeded { op, value } => {
                    self.ops.insert(op, Ok(value));
                }
                Command::OperationFailed { op, error } => {
                    self.ops.insert(op, Err(error));
                }
            }
        }
    }

    /// Drain whatever the socket currently has (non-blocking reads with a
    /// short deadline — the host's replies arrive promptly). Events are
    /// collected first and dispatched after, so SendBytes produced while
    /// reading still finds this conn in the map.
    fn read_socket(&mut self, conn: u32) {
        let mut events = Vec::new();
        let mut closed = false;
        if let Some(socket) = self.sockets.get_mut(&conn) {
            socket.get_mut().set_nonblocking(true).expect("nonblocking");
            let deadline = Instant::now() + Duration::from_millis(50);
            loop {
                match socket.read() {
                    Ok(Message::Text(text)) => {
                        events.push(Event::SocketData { conn, bytes: text.as_bytes().to_vec() });
                    }
                    Ok(Message::Binary(bytes)) => {
                        events.push(Event::SocketData { conn, bytes: bytes.to_vec() });
                    }
                    Ok(Message::Close(frame)) => {
                        let code = frame.as_ref().map(|f| f.code.into()).unwrap_or(1000);
                        let reason = frame.map(|f| f.reason.to_string());
                        events.push(Event::SocketClosed { conn, code, reason });
                        closed = true;
                        break;
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() > deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => {
                        eprintln!("ws error on conn {conn}: {error:?}");
                        events.push(Event::SocketClosed { conn, code: 1006, reason: None });
                        closed = true;
                        break;
                    }
                }
            }
            socket.get_mut().set_nonblocking(false).expect("blocking");
        }
        if closed {
            self.sockets.remove(&conn);
        }
        for event in events {
            let more = self.remote.handle(event);
            self.pending.extend(more);
        }
        // Commands produced while reading (subscribes after the hello,
        // results after a call) must be executed here too — wait_until
        // calls read_socket directly, without a surrounding pump.
        self.pump(Vec::new());
    }

    /// Read until `pred` holds or the deadline passes.
    fn wait_until(&mut self, deadline: Duration, pred: impl Fn(&Self) -> bool) {
        let start = Instant::now();
        while !pred(self) {
            if start.elapsed() > deadline {
                panic!("timed out waiting for condition");
            }
            let conns: Vec<u32> = self.sockets.keys().copied().collect();
            for conn in conns {
                self.read_socket(conn);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn invoke(&mut self, op: u64, call: Call) {
        let commands = self.remote.handle(Event::Invoke { op, call });
        self.pump(commands);
    }
}

/// The full mobile-client path: plaintext admin → createPairing → Noise IK
/// pairing → subscribe → snapshot+ops → conversation sync.
#[test]
fn interop_pairs_and_synchronizes_a_conversation() {
    let host = spawn_host();

    // Phase 1: the token-authenticated admin client (the Web/desktop path)
    // mints a pairing link over the plaintext lane.
    let admin_url = format!("{}/?token={}", host.url.trim_end_matches('/'), host.token);
    let mut admin = Driver::new(RemoteDurable::new(RemoteDurableOptions {
        transport: Box::new(PlaintextTransport { url: admin_url }),
        reconnect_delay_ms: None,
        request_id: None,
    }));
    admin.wait_until(Duration::from_secs(10), |driver| driver.ready.is_some());
    assert_eq!(admin.ready, Some(ReadyOutcome::Connected));

    admin.invoke(1, Call::CreatePairing);
    admin.wait_until(Duration::from_secs(10), |driver| driver.ops.contains_key(&1));
    let pairing = admin.ops.get(&1).as_ref().unwrap().as_ref().unwrap().clone().unwrap();
    let link = pairing.get("url").and_then(Json::as_str).map(|s| s.to_string_lossy()).expect("pairing url");
    let parsed = parse_pairing_link(&link).expect("parse pairing link");

    // Phase 2: a brand-new device pairs over the Noise channel — what the
    // mobile app does after scanning the link.
    let device = pinomad_core::noise::generate_keypair().expect("device keypair");
    let device_private = to_base64url(&device.private_key);
    let mut remote = Driver::new(RemoteDurable::new(RemoteDurableOptions {
        transport: Box::new(
            SecureTransport::new(
                &parsed.url,
                &to_base64url(&parsed.host_key),
                &device_private,
                Some(Pairing { secret: parsed.secret.clone(), name: "interop-rust".to_string() }),
            )
            .expect("secure transport"),
        ),
        reconnect_delay_ms: None,
        request_id: None,
    }));
    remote.wait_until(Duration::from_secs(15), |driver| driver.ready.is_some());
    assert_eq!(remote.ready, Some(ReadyOutcome::Connected));
    assert!(remote.paired.is_some(), "the channel must report the completed pairing");
    assert_eq!(remote.paired.as_ref().unwrap().1, to_base64url(&parsed.host_key));

    // Phase 3: subscribe-and-sync — create a conversation, switch to it, and
    // see its snapshot plus the index/conversations ops that list it.
    remote.invoke(2, Call::CreateConversation {
        home: Json::parse(r#"{"kind":"chat"}"#).unwrap(),
        text: "hello from rust".to_string(),
        checkout: None,
        model: None,
        thinking_level: None,
        images: vec![],
    });
    remote.wait_until(Duration::from_secs(15), |driver| {
        driver.ops.contains_key(&2)
            && driver
                .remote
                .view()
                .and_then(|view| view.get("conversation").cloned())
                .is_some()
    });
    assert!(remote.ops.get(&2).unwrap().is_ok(), "createConversation failed: {:?}", remote.ops);
    let view = remote.remote.view().unwrap();
    let conversation = view.get("conversation").expect("a shown conversation");
    let conversation_id = conversation
        .get("conversation")
        .and_then(|c| c.get("id"))
        .and_then(Json::as_number)
        .expect("conversation id");
    // The conversation stream's snapshot is in — entries may be empty or
    // already carrying the faux model's first ops, both are sync progress.
    assert!(conversation.get("entries").is_some() || conversation.get("conversation").is_some());
    // The index/conversations streams list the new conversation.
    let organized = view.get("organized").unwrap();
    let listed = {
        let mut found = false;
        for list in ["chats", "projects"] {
            if let Some(nodes) = organized.get(list).and_then(Json::as_array) {
                for node in nodes.iter() {
                    let convos = if list == "chats" {
                        vec![node.clone()]
                    } else {
                        node.get("conversations").and_then(Json::as_array).map(|a| a.as_ref().clone()).unwrap_or_default()
                    };
                    for convo in convos {
                        if convo.get("summary").and_then(|s| s.get("id")).and_then(Json::as_number) == Some(conversation_id) {
                            found = true;
                        }
                    }
                }
            }
        }
        found
    };
    assert!(listed, "the new conversation must appear in the organized view: {}", organized.to_json());
}
