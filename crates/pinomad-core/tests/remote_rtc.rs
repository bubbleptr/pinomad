// Deterministic Rust coordinator tests for the RTC standby path: a scripted
// WebSocket host plus a fake DataChannel host driven through Event/Command.
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use pinomad_core::b64::to_base64url;
use pinomad_core::connection_mode::ConnectionMode;
use pinomad_core::frames::{ClientFrame, PROTOCOL};
use pinomad_core::json::{Json, JsonObject};
use pinomad_core::noise::{generate_keypair, KeyPair};
use pinomad_core::remote_candidates::{RemoteCandidate, RemoteCandidateRole};
use pinomad_core::remote_durable::{
    CandidateSource, CandidateTimeouts, Command, Event, ReadyOutcome, RemoteDurable,
    RemoteDurableOptions, RtcOptions, RtcSendOutcome,
};
use pinomad_core::secure_channel::{encode_host_hello, respond_handshake, SecureSession};
use pinomad_core::transport::{ConnOut, Connection};
use pinomad_core::u16str::U16String;

fn obj(fields: &[(&str, Json)]) -> Json {
    let mut object = JsonObject::new();
    for (name, value) in fields {
        object.set(U16String::from_str(name), value.clone());
    }
    Json::Object(Arc::new(object))
}

fn snapshot_for(stream: &str) -> Json {
    match stream {
        "conversations" => Json::array(vec![]),
        "index" => obj(&[
            ("projects", Json::array(vec![])),
            ("conversations", Json::array(vec![])),
        ]),
        "devices" => obj(&[("devices", Json::array(vec![]))]),
        "tasks" => obj(&[("tasks", obj(&[]))]),
        "models" => Json::array(vec![]),
        "settings" => obj(&[
            ("defaultModel", Json::Null),
            ("defaultThinkingLevel", Json::Null),
            ("steeringMode", Json::from("all")),
            ("followUpMode", Json::from("all")),
            ("custom", Json::array(vec![])),
        ]),
        "agents" => obj(&[
            ("roles", Json::array(vec![])),
            ("problems", Json::array(vec![])),
        ]),
        "providers" => obj(&[
            ("providers", Json::array(vec![])),
            ("logins", Json::array(vec![])),
        ]),
        "auth" => obj(&[("logins", Json::array(vec![]))]),
        "mcp" => Json::Null,
        _ if stream.starts_with("conversation:") => obj(&[
            ("conversation", obj(&[("id", Json::Number(1.0))])),
            ("entries", Json::array(vec![])),
        ]),
        _ => Json::Null,
    }
}

fn rtc_hello() -> Json {
    obj(&[
        ("stun", Json::array(vec![])),
        ("signalOnly", Json::Bool(true)),
    ])
}

fn hello() -> Json {
    obj(&[
        ("type", Json::from("hello")),
        (
            "protocol",
            obj(&[
                ("major", Json::Number(PROTOCOL.major as f64)),
                ("minor", Json::Number(PROTOCOL.minor as f64)),
            ]),
        ),
        (
            "session",
            obj(&[("id", Json::from("fake")), ("directory", Json::from(""))]),
        ),
        ("models", Json::array(vec![])),
        ("docs", Json::array(vec![])),
        ("toolPresentations", obj(&[])),
        ("defaults", obj(&[])),
        ("rtc", rtc_hello()),
    ])
}

fn signal_hello() -> Json {
    obj(&[
        ("type", Json::from("signalHello")),
        (
            "protocol",
            obj(&[
                ("major", Json::Number(PROTOCOL.major as f64)),
                ("minor", Json::Number(PROTOCOL.minor as f64)),
            ]),
        ),
        ("rtc", rtc_hello()),
    ])
}

fn answer() -> Json {
    obj(&[("sdp", Json::from("v=0\r\na=max-message-size:65536\r\n"))])
}

struct ScriptSource;

impl CandidateSource for ScriptSource {
    fn open(&mut self, _candidate: &RemoteCandidate) -> Box<dyn Connection> {
        Box::new(FakeSocket { signal: false })
    }
    fn open_signal(&mut self, _candidate: &RemoteCandidate) -> Box<dyn Connection> {
        Box::new(FakeSocket { signal: true })
    }
}

struct FakeSocket {
    signal: bool,
}

impl Connection for FakeSocket {
    fn opened(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Authenticated { paired: false });
        out.push(ConnOut::Text(if self.signal { signal_hello() } else { hello() }.to_json()));
    }
    fn data(&mut self, _bytes: &[u8], _out: &mut Vec<ConnOut>) {}
    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Closed { code, reason });
    }
    fn send(&mut self, text: String, out: &mut Vec<ConnOut>) {
        let Ok(frame) = Json::parse(&text) else { return };
        let frame_type = frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
        if frame_type == "subscribe" {
            let stream = frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
            let snapshot = obj(&[
                ("type", Json::from("snapshot")),
                ("stream", Json::from(stream.clone())),
                ("value", snapshot_for(&stream)),
            ]);
            out.push(ConnOut::Text(snapshot.to_json()));
            return;
        }
        if frame_type != "call" {
            return;
        }
        let method = frame.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
        let id = frame.get("id").and_then(Json::as_number).unwrap_or(0.0);
        let value = if method == "rtcOffer" { answer() } else { obj(&[]) };
        let result = obj(&[
            ("type", Json::from("result")),
            ("id", Json::Number(id)),
            ("ok", Json::Bool(true)),
            ("value", value),
        ]);
        out.push(ConnOut::Text(result.to_json()));
    }
    fn close(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
    }
}

struct FakeRtcHost {
    host: KeyPair,
    session: Option<SecureSession>,
    hold_from: Option<usize>,
    held: Vec<(u64, String)>,
    pings: Vec<String>,
    calls: Vec<ClientFrame>,
    hold_streams: std::collections::HashSet<String>,
    closed: bool,
}

impl FakeRtcHost {
    fn new() -> Self {
        FakeRtcHost {
            host: generate_keypair().expect("host key"),
            session: None,
            hold_from: None,
            held: Vec::new(),
            pings: Vec::new(),
            calls: Vec::new(),
            hold_streams: std::collections::HashSet::new(),
            closed: false,
        }
    }

    fn process(&mut self, record: &[u8]) -> Vec<Event> {
        let mut events = Vec::new();
        if self.closed {
            return events;
        }
        if self.session.is_none() {
            let Ok(mut handshake) = respond_handshake(&self.host) else { return events };
            let Ok((_payload, _device)) = handshake.read_message1(record) else { return events };
            let Ok((message, session)) = handshake.write_message2(&encode_host_hello()) else { return events };
            self.session = Some(session);
            events.push(Event::RtcData { peer: 0, bytes: message });
            let hello = hello().to_json();
            if let Some(session) = self.session.as_mut() {
                for record in session.seal(&hello).unwrap_or_default() {
                    events.push(Event::RtcData { peer: 0, bytes: record });
                }
            }
            return events;
        }
        let Some(session) = self.session.as_mut() else { return events };
        let Ok(Some(text)) = session.open(record) else { return events };
        let Ok(frame) = Json::parse(&text) else { return events };
        let frame_type = frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
        if frame_type == "subscribe" {
            let stream = frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
            if self.hold_streams.contains(&stream) {
                return events;
            }
            let snapshot = obj(&[
                ("type", Json::from("snapshot")),
                ("stream", Json::from(stream.clone())),
                ("value", snapshot_for(&stream)),
            ]).to_json();
            for record in session.seal(&snapshot).unwrap_or_default() {
                events.push(Event::RtcData { peer: 0, bytes: record });
            }
            return events;
        }
        if frame_type != "call" {
            return events;
        }
        let method = frame.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
        let id = frame.get("id").and_then(Json::as_number).unwrap_or(0.0) as u64;
        if method == "ping" {
            let probe = frame.get("args").and_then(|a| a.get("id")).and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
            self.pings.push(probe.clone());
            if self.hold_from.is_some_and(|from| self.pings.len() >= from) {
                self.held.push((id, probe));
                return events;
            }
            let result = obj(&[
                ("type", Json::from("result")),
                ("id", Json::Number(id as f64)),
                ("ok", Json::Bool(true)),
                ("value", obj(&[("id", Json::from(probe))])),
            ]).to_json();
            for record in session.seal(&result).unwrap_or_default() {
                events.push(Event::RtcData { peer: 0, bytes: record });
            }
            return events;
        }
        self.calls.push(ClientFrame::Call {
            id: id as f64,
            method: U16String::from_str(&method),
            args: frame.get("args").cloned().unwrap_or(Json::Null),
        });
        let result = obj(&[
            ("type", Json::from("result")),
            ("id", Json::Number(id as f64)),
            ("ok", Json::Bool(true)),
            ("value", obj(&[])),
        ]).to_json();
        for record in session.seal(&result).unwrap_or_default() {
            events.push(Event::RtcData { peer: 0, bytes: record });
        }
        events
    }

    fn release_held(&mut self) -> Vec<Event> {
        self.hold_from = None;
        let mut events = Vec::new();
        let held = std::mem::take(&mut self.held);
        let Some(session) = self.session.as_mut() else { return events };
        for (id, probe) in held {
            let result = obj(&[
                ("type", Json::from("result")),
                ("id", Json::Number(id as f64)),
                ("ok", Json::Bool(true)),
                ("value", obj(&[("id", Json::from(probe))])),
            ]).to_json();
            for record in session.seal(&result).unwrap_or_default() {
                events.push(Event::RtcData { peer: 0, bytes: record });
            }
        }
        events
    }
}

struct Harness {
    remote: RemoteDurable,
    host: FakeRtcHost,
    timers: BTreeMap<u32, u64>,
    now: u64,
    next_due: u64,
    ws_frames: Vec<ClientFrame>,
    rtc_records: Vec<Vec<u8>>,
    ready: Option<ReadyOutcome>,
    peers: Vec<u32>,
    closed_peers: Vec<u32>,
    ops: HashMap<u64, Result<Option<Json>, String>>,
    fail_peers: bool,
}

impl Harness {
    fn new(candidates: Vec<RemoteCandidate>, mode: ConnectionMode) -> Self {
        let host = FakeRtcHost::new();
        let rtc = RtcOptions {
            host_key: to_base64url(&host.host.public_key),
            device_private_key: to_base64url(&generate_keypair().expect("device key").private_key),
            signal_only_hint: true,
        };
        let remote = RemoteDurable::new(RemoteDurableOptions {
            source: Box::new(ScriptSource),
            mode: pinomad_core::remote_durable::RemoteMode::Planned,
            reconnect_delay_ms: Some((10, 10)),
            request_id: None,
            candidates,
            legacy_url: None,
            page_protocol: None,
            host_key: host.host.public_key.iter().map(|b| format!("{b:02x}")).collect(),
            pairing_endpoint_set: None,
            candidate_timeouts: CandidateTimeouts {
                socket_open_ms: 100,
                noise_ms: 100,
                hello_ms: 100,
                sync_ms: 1_000,
            },
            round_timeout_ms: Some(10_000),
            connection_mode: mode,
            rtc: Some(rtc),
        });
        let mut harness = Harness {
            remote,
            host,
            timers: BTreeMap::new(),
            now: 0,
            next_due: 0,
            ws_frames: Vec::new(),
            rtc_records: Vec::new(),
            ready: None,
            peers: Vec::new(),
            closed_peers: Vec::new(),
            ops: HashMap::new(),
            fail_peers: false,
        };
        let initial = harness.remote.take();
        harness.pump(initial);
        harness
    }

    fn feed(&mut self, event: Event) {
        let commands = self.remote.handle(event);
        self.pump(commands);
    }

    fn pump(&mut self, commands: Vec<Command>) {
        let mut queue: VecDeque<Command> = commands.into();
        while let Some(command) = queue.pop_front() {
            match command {
                Command::OpenConnection { conn, url } => {
                    self.ws_frames.clear();
                    let _ = url;
                    queue.extend(self.remote.handle(Event::SocketOpened { conn }));
                }
                Command::SendBytes { conn, bytes } => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        if let Ok(frame) = Json::parse(&text) {
                            if frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() == Some("call") {
                                let method = frame.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
                                let id = frame.get("id").and_then(Json::as_number).unwrap_or(0.0);
                                self.ws_frames.push(ClientFrame::Call {
                                    id,
                                    method: U16String::from_str(&method),
                                    args: frame.get("args").cloned().unwrap_or(Json::Null),
                                });
                                let result = if method == "rtcOffer" {
                                    obj(&[
                                        ("type", Json::from("result")),
                                        ("id", Json::Number(id)),
                                        ("ok", Json::Bool(true)),
                                        ("value", answer()),
                                    ])
                                } else {
                                    obj(&[
                                        ("type", Json::from("result")),
                                        ("id", Json::Number(id)),
                                        ("ok", Json::Bool(true)),
                                        ("value", obj(&[])),
                                    ])
                                };
                                queue.extend(self.remote.handle(Event::SocketData {
                                    conn,
                                    bytes: result.to_json().into_bytes(),
                                }));
                            } else if frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() == Some("subscribe") {
                                let stream = frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
                                let snapshot = obj(&[
                                    ("type", Json::from("snapshot")),
                                    ("stream", Json::from(stream.clone())),
                                    ("value", snapshot_for(&stream)),
                                ]);
                                queue.extend(self.remote.handle(Event::SocketData {
                                    conn,
                                    bytes: snapshot.to_json().into_bytes(),
                                }));
                            }
                        }
                    }
                }
                Command::CreateRtcPeer { peer, stun } => {
                    assert!(stun.is_empty());
                    self.peers.push(peer);
                    if self.fail_peers {
                        queue.extend(self.remote.handle(Event::RtcClosed {
                            peer,
                            reason: Some("no candidates".to_string()),
                        }));
                    } else {
                        queue.extend(self.remote.handle(Event::RtcPeerReady {
                            peer,
                            sdp: "v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 9000 typ host\r\n".to_string(),
                        }));
                    }
                }
                Command::AcceptRtcAnswer { peer, sdp } => {
                    assert!(sdp.contains("max-message-size"));
                    queue.extend(self.remote.handle(Event::RtcChannelOpened { peer }));
                }
                Command::RtcSend { peer, bytes } => {
                    self.rtc_records.push(bytes.clone());
                    let events = self.host.process(&bytes);
                    queue.extend(self.remote.handle(Event::RtcSendResult {
                        peer,
                        outcome: RtcSendOutcome::Accepted,
                    }));
                    for event in events {
                        match event {
                            Event::RtcData { peer: _, bytes } => {
                                queue.extend(self.remote.handle(Event::RtcData { peer, bytes }));
                            }
                            other => queue.extend(self.remote.handle(other)),
                        }
                    }
                }
                Command::CloseRtcPeer { peer } => self.closed_peers.push(peer),
                Command::CloseSocket { .. } => {}
                Command::ScheduleDeadline { timer, delay_ms } => {
                    self.next_due += 1;
                    self.timers.insert(timer, self.now + delay_ms);
                }
                Command::CancelDeadline { timer } => {
                    self.timers.remove(&timer);
                }
                Command::ScheduleReconnect { timer, delay_ms } => {
                    self.next_due += 1;
                    self.timers.insert(timer, self.now + delay_ms);
                }
                Command::CancelReconnect { timer } => {
                    self.timers.remove(&timer);
                }
                Command::Ready { outcome } => self.ready = Some(outcome),
                Command::CandidateFailed { .. }
                | Command::EndpointSet { .. }
                | Command::Paired { .. }
                | Command::ViewChanged
                | Command::RtcSignalOnly { .. } => {}
                Command::OperationSucceeded { op, value } => {
                    self.ops.insert(op, Ok(value));
                }
                Command::OperationFailed { op, error } => {
                    self.ops.insert(op, Err(error));
                }
            }
        }
    }

    fn advance(&mut self, ms: u64) {
        let target = self.now + ms;
        loop {
            let next = self
                .timers
                .iter()
                .filter(|(_, due)| **due <= target)
                .min_by_key(|(_, due)| **due)
                .map(|(timer, due)| (*timer, *due));
            let Some((timer, due)) = next else { break };
            self.now = due;
            self.timers.remove(&timer);
            self.feed(Event::Clock { now_ms: self.now });
            self.feed(Event::TimerFired { timer });
        }
        self.now = target;
        self.feed(Event::Clock { now_ms: self.now });
    }
}

fn candidates() -> Vec<RemoteCandidate> {
    vec![
        RemoteCandidate { url: "wss://relay/".to_string(), role: RemoteCandidateRole::Relay, unsupported: None },
        RemoteCandidate { url: "wss://direct/".to_string(), role: RemoteCandidateRole::Direct, unsupported: None },
    ]
}

#[test]
fn auto_upgrade_waits_for_idle_and_hands_queued_submit_to_p2p() {
    let mut h = Harness::new(candidates(), ConnectionMode::Auto);
    assert!(matches!(h.ready, Some(ReadyOutcome::Connected)));
    h.advance(1_100);
    assert_eq!(h.peers.len(), 1);
    // Warm ping, then the preverify ping is held so the idle barrier is real.
    h.host.hold_from = Some(2);
    h.advance(300);
    assert!(
        h.host.pings.len() >= 2,
        "preverify ping was sent: pings={:?} diag={}",
        h.host.pings,
        h.remote.rtc_diagnostics().to_json()
    );
    h.feed(Event::Invoke {
        op: 2,
        call: pinomad_core::remote_durable::Call::Submit {
            text: "during commit".to_string(),
            when_busy: "followUp".to_string(),
            target: Some(1),
            request_id: Some("req".to_string()),
            images: Vec::new(),
            skills: None,
            attachments: Vec::new(),
        },
    });
    // The submit is held in the barrier: neither carrier has seen it yet.
    assert!(!h.host.calls.iter().any(|frame| matches!(frame, ClientFrame::Call { method, .. } if method.to_string_lossy() == "submit")));
    let events = h.host.release_held();
    let peer = h.peers[0];
    for event in events {
        if let Event::RtcData { bytes, .. } = event {
            h.feed(Event::RtcData { peer, bytes });
        }
    }
    h.advance(10);
    assert!(
        h.host
            .calls
            .iter()
            .any(|frame| matches!(frame, ClientFrame::Call { method, .. } if method.to_string_lossy() == "submit")),
        "diag={} view={} host_calls={:?}",
        h.remote.rtc_diagnostics().to_json(),
        h.remote.view_json().unwrap_or_default(),
        h.host.calls
    );
    assert_eq!(
        h.remote
            .rtc_diagnostics()
            .get("path")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .as_deref(),
        Some("p2p")
    );
}

#[test]
fn liveness_timeout_falls_back_and_quietly_retries_after_60s() {
    let mut h = Harness::new(candidates(), ConnectionMode::Auto);
    h.advance(1_500);
    assert_eq!(h.remote.rtc_diagnostics().get("path").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref(), Some("p2p"));
    h.host.hold_from = Some(h.host.pings.len() + 1);
    h.advance(15_100);
    assert_eq!(h.remote.rtc_diagnostics().get("path").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref(), Some("relay"));
    assert!(h.remote.view().and_then(|view| view.get("unauthorized").cloned()).is_none());
    let peers = h.peers.len();
    h.advance(59_000);
    assert_eq!(h.peers.len(), peers);
}

#[test]
fn relay_only_never_creates_an_rtc_peer() {
    let mut h = Harness::new(candidates(), ConnectionMode::RelayOnly);
    h.advance(5_000);
    assert!(h.peers.is_empty());
    assert_eq!(h.ready, Some(ReadyOutcome::Connected));
}

#[test]
fn unsupported_rtc_emits_no_rtc_commands() {
    let host = FakeRtcHost::new();
    let mut remote = RemoteDurable::new(RemoteDurableOptions {
        source: Box::new(ScriptSource),
        mode: pinomad_core::remote_durable::RemoteMode::Planned,
        reconnect_delay_ms: Some((10, 10)),
        request_id: None,
        candidates: candidates(),
        legacy_url: None,
        page_protocol: None,
        host_key: host.host.public_key.iter().map(|b| format!("{b:02x}")).collect(),
        pairing_endpoint_set: None,
        candidate_timeouts: CandidateTimeouts::default(),
        round_timeout_ms: Some(10_000),
        connection_mode: ConnectionMode::Auto,
        rtc: None,
    });
    let mut commands = remote.take();
    let mut rtc_commands = 0;
    while let Some(command) = commands.pop() {
        match command {
            Command::CreateRtcPeer { .. }
            | Command::AcceptRtcAnswer { .. }
            | Command::RtcSend { .. }
            | Command::CloseRtcPeer { .. }
            | Command::RtcSignalOnly { .. } => rtc_commands += 1,
            Command::OpenConnection { conn, .. } => {
                commands.extend(remote.handle(Event::SocketOpened { conn }));
            }
            Command::SendBytes { conn, .. } => {
                let hello = hello().to_json().into_bytes();
                commands.extend(remote.handle(Event::SocketData { conn, bytes: hello }));
            }
            _ => {}
        }
    }
    assert_eq!(rtc_commands, 0);
}

#[test]
fn preparation_failure_doubles_the_cooldown() {
    let mut h = Harness::new(candidates(), ConnectionMode::Auto);
    h.fail_peers = true;
    h.advance(1_100);
    assert_eq!(h.peers.len(), 1);
    assert!(h.remote.rtc_diagnostics().get("cooldownRemainingMs").and_then(Json::as_number).unwrap_or(0.0) > 29_000.0);
    h.advance(30_100);
    assert_eq!(h.peers.len(), 2);
    assert!(h.remote.rtc_diagnostics().get("cooldownRemainingMs").and_then(Json::as_number).unwrap_or(0.0) > 59_000.0);
}

#[test]
fn preverify_failure_returns_the_queue_to_the_old_carrier() {
    let mut h = Harness::new(candidates(), ConnectionMode::Auto);
    h.advance(1_100);
    h.host.hold_from = Some(2);
    h.advance(300);
    h.feed(Event::Invoke {
        op: 1,
        call: pinomad_core::remote_durable::Call::Submit {
            text: "back to relay".to_string(),
            when_busy: "followUp".to_string(),
            target: Some(1),
            request_id: Some("req".to_string()),
            images: Vec::new(),
            skills: None,
            attachments: Vec::new(),
        },
    });
    // The preverify deadline releases the barrier; the old WebSocket answers.
    h.advance(3_100);
    assert!(h.ops.get(&1).is_some_and(|result| result.is_ok()));
    assert_eq!(
        h.remote.rtc_diagnostics().get("path").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref(),
        Some("relay")
    );
}

#[test]
fn sync_failure_fails_queued_ops_and_does_not_replay_them() {
    let mut h = Harness::new(candidates(), ConnectionMode::Auto);
    h.advance(1_100);
    h.host.hold_streams.insert("index".to_string());
    h.host.hold_from = Some(2);
    h.advance(300);
    h.feed(Event::Invoke {
        op: 2,
        call: pinomad_core::remote_durable::Call::Changes { target: Some(1) },
    });
    let events = h.host.release_held();
    let peer = h.peers[0];
    for event in events {
        if let Event::RtcData { bytes, .. } = event {
            h.feed(Event::RtcData { peer, bytes });
        }
    }
    h.advance(1_100);
    assert!(matches!(h.ops.get(&2), Some(Err(_))));
    assert!(!h.host.calls.iter().any(|frame| matches!(frame, ClientFrame::Call { method, .. } if method.to_string_lossy() == "changes")));
}

#[test]
fn direct_only_reaches_p2p_through_a_signal_only_connection() {
    let h = Harness::new(
        vec![RemoteCandidate {
            url: "wss://relay/".to_string(),
            role: RemoteCandidateRole::Relay,
            unsupported: None,
        }],
        ConnectionMode::DirectOnly,
    );
    assert!(matches!(h.ready, Some(ReadyOutcome::Connected)));
    assert_eq!(
        h.remote.rtc_diagnostics().get("path").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref(),
        Some("p2p")
    );
    assert_eq!(h.peers.len(), 1);
    assert!(h
        .host
        .calls
        .iter()
        .all(|frame| !matches!(frame, ClientFrame::Call { method, .. } if method.to_string_lossy() == "submit")));
}
