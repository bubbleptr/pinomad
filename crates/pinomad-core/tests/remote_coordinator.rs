// The candidate coordinator (ADR-0032): ordered serial dials, one shared
// pairing identity per round, finite stage deadlines, late-event retirement,
// and whole-round error aggregation. The scripted connections are driven by
// the same event/command loop the platform uses.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use pinomad_core::endpoints::{EndpointSet, HostEndpoint, HostEndpointRole};
use pinomad_core::frames::PROTOCOL;
use pinomad_core::json::{Json, JsonObject};
use pinomad_core::remote_candidates::{RemoteCandidate, RemoteCandidateRole};
use pinomad_core::remote_durable::{
    CandidateFailureStage, CandidateSource, CandidateTimeouts, Command, Event, ReadyOutcome,
    RemoteDurable, RemoteDurableOptions,
};
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
        _ => Json::Null,
    }
}

fn hello(endpoint_set: Option<EndpointSet>, major: f64) -> Json {
    let mut fields = vec![
        ("type", Json::from("hello")),
        (
            "protocol",
            obj(&[
                ("major", Json::from(major)),
                ("minor", Json::from(PROTOCOL.minor as f64)),
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
    ];
    if let Some(set) = endpoint_set {
        fields.push(("endpointSet", set.to_json()));
    }
    obj(&fields)
}

fn malformed_hello() -> Json {
    obj(&[
        ("type", Json::from("hello")),
        (
            "protocol",
            obj(&[
                ("major", Json::from(PROTOCOL.major as f64)),
                ("minor", Json::from(PROTOCOL.minor as f64)),
            ]),
        ),
        (
            "session",
            obj(&[("id", Json::from("fake")), ("directory", Json::from(""))]),
        ),
        ("models", Json::array(vec![])),
        ("docs", Json::from("junk")),
        ("toolPresentations", obj(&[])),
        ("defaults", obj(&[])),
    ])
}

#[derive(Clone)]
struct Script {
    /// Emit Noise message 2 on open.
    auth: bool,
    /// Emit a hello immediately after auth.
    hello: Option<Json>,
    /// Close right after the open/auth/hello outcomes above.
    close: Option<u16>,
    /// Do not simulate the platform's socket-opened callback.
    silent_open: bool,
    /// Answer subscribes with snapshots; false makes first sync stall.
    answer_sync: bool,
}

impl Script {
    fn healthy() -> Self {
        Script {
            auth: true,
            hello: Some(hello(None, PROTOCOL.major as f64)),
            close: None,
            silent_open: false,
            answer_sync: true,
        }
    }

    fn open_timeout() -> Self {
        Script {
            auth: false,
            hello: None,
            close: None,
            silent_open: true,
            answer_sync: false,
        }
    }

    fn noise_timeout() -> Self {
        Script {
            auth: false,
            hello: None,
            close: None,
            silent_open: false,
            answer_sync: false,
        }
    }

    fn hello_timeout() -> Self {
        Script {
            auth: true,
            hello: None,
            close: None,
            silent_open: false,
            answer_sync: false,
        }
    }

    fn sync_timeout() -> Self {
        Script {
            auth: true,
            hello: Some(hello(None, PROTOCOL.major as f64)),
            close: None,
            silent_open: false,
            answer_sync: false,
        }
    }

    fn rejected(code: u16) -> Self {
        Script {
            auth: false,
            hello: None,
            close: Some(code),
            silent_open: false,
            answer_sync: false,
        }
    }
}

#[derive(Clone)]
struct OpenRecord {
    url: String,
    paired: bool,
    script: Script,
    subscribes: usize,
}

struct Shared {
    scripts: HashMap<String, VecDeque<Script>>,
    opens: Vec<OpenRecord>,
    paired_calls: usize,
    pairing_active: bool,
    /// Inbound frames the fake host produced while handling a client send.
    /// They are delivered after the core returns, like a real socket's next
    /// receive callback.
    responses: Vec<String>,
}

#[derive(Clone)]
struct FakeSource(Arc<Mutex<Shared>>);

impl CandidateSource for FakeSource {
    fn open(&mut self, candidate: &RemoteCandidate) -> Box<dyn Connection> {
        let mut shared = self.0.lock().unwrap();
        let script = shared
            .scripts
            .get_mut(&candidate.url)
            .and_then(|queue| queue.pop_front())
            .unwrap_or_else(Script::healthy);
        let paired = shared.pairing_active;
        shared.opens.push(OpenRecord {
            url: candidate.url.clone(),
            paired,
            script: script.clone(),
            subscribes: 0,
        });
        Box::new(FakeConnection {
            shared: self.0.clone(),
            script,
            paired,
        })
    }

    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        let mut shared = self.0.lock().unwrap();
        shared.paired_calls += 1;
        shared.pairing_active = false;
        let url = shared
            .opens
            .last()
            .map(|open| open.url.clone())
            .unwrap_or_default();
        Some((url, "host-key".to_string(), "device-key".to_string()))
    }
}

struct FakeConnection {
    shared: Arc<Mutex<Shared>>,
    script: Script,
    paired: bool,
}

impl Connection for FakeConnection {
    fn opened(&mut self, out: &mut Vec<ConnOut>) {
        if self.script.silent_open {
            return;
        }
        if self.script.auth {
            out.push(ConnOut::Authenticated {
                paired: self.paired,
            });
        }
        if let Some(hello) = &self.script.hello {
            out.push(ConnOut::Text(hello.to_json()));
        }
        if let Some(code) = self.script.close {
            out.push(ConnOut::Closed { code, reason: None });
        }
    }

    fn data(&mut self, bytes: &[u8], out: &mut Vec<ConnOut>) {
        if let Ok(text) = String::from_utf8(bytes.to_vec()) {
            out.push(ConnOut::Text(text));
        }
    }

    fn closed(&mut self, code: u16, reason: Option<String>, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Closed { code, reason });
    }

    fn send(&mut self, text: String, _out: &mut Vec<ConnOut>) {
        let Ok(frame) = Json::parse(&text) else {
            return;
        };
        if frame
            .get("type")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .as_deref()
            != Some("subscribe")
        {
            return;
        }
        let Some(stream) = frame
            .get("stream")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
        else {
            return;
        };
        if let Some(open) = self.shared.lock().unwrap().opens.last_mut() {
            open.subscribes += 1;
        }
        if !self.script.answer_sync {
            return;
        }
        self.shared.lock().unwrap().responses.push(
            obj(&[
                ("type", Json::from("snapshot")),
                ("stream", Json::from(stream)),
                (
                    "value",
                    snapshot_for(
                        &frame
                            .get("stream")
                            .and_then(Json::as_str)
                            .map(|s| s.to_string_lossy())
                            .unwrap_or_default(),
                    ),
                ),
            ])
            .to_json(),
        );
    }

    fn close(&mut self, out: &mut Vec<ConnOut>) {
        out.push(ConnOut::Close);
    }
}

struct Harness {
    remote: RemoteDurable,
    shared: Arc<Mutex<Shared>>,
    ready: Option<ReadyOutcome>,
    paired: Vec<(String, String, String, Option<EndpointSet>)>,
    failures: Vec<pinomad_core::remote_durable::CandidateFailure>,
    endpoints: Vec<(String, String, EndpointSet)>,
    deadlines: Vec<(u32, u64)>,
    reconnect: Vec<(u32, u64)>,
    canceled: Vec<u32>,
    next_conn: u32,
    live_conn: Option<u32>,
}

impl Harness {
    fn new(
        candidates: Vec<RemoteCandidate>,
        scripts: Vec<(&str, Vec<Script>)>,
        pairing: bool,
    ) -> Self {
        Self::with_timeouts(
            candidates,
            scripts,
            pairing,
            CandidateTimeouts {
                socket_open_ms: 100,
                noise_ms: 200,
                hello_ms: 300,
                sync_ms: 400,
            },
            Some(5_000),
        )
    }

    fn with_timeouts(
        candidates: Vec<RemoteCandidate>,
        scripts: Vec<(&str, Vec<Script>)>,
        pairing: bool,
        candidate_timeouts: CandidateTimeouts,
        round_timeout_ms: Option<u64>,
    ) -> Self {
        let mut table: HashMap<String, VecDeque<Script>> = HashMap::new();
        for (url, queue) in scripts {
            table.entry(url.to_string()).or_default().extend(queue);
        }
        let shared = Arc::new(Mutex::new(Shared {
            scripts: table,
            opens: Vec::new(),
            paired_calls: 0,
            pairing_active: pairing,
            responses: Vec::new(),
        }));
        let source = FakeSource(shared.clone());
        let legacy = candidates
            .first()
            .map(|candidate| candidate.url.clone())
            .unwrap_or_default();
        let remote = RemoteDurable::new(RemoteDurableOptions {
            source: Box::new(source),
            mode: pinomad_core::remote_durable::RemoteMode::Planned,
            reconnect_delay_ms: Some((10, 10)),
            request_id: None,
            candidates,
            legacy_url: Some(legacy),
            page_protocol: None,
            host_key: "host-key".to_string(),
            pairing_endpoint_set: None,
            candidate_timeouts,
            round_timeout_ms,
            connection_mode: pinomad_core::connection_mode::ConnectionMode::Auto,
            rtc: None,
            logical_submissions: false,
        });
        let mut harness = Harness {
            remote,
            shared,
            ready: None,
            paired: Vec::new(),
            failures: Vec::new(),
            endpoints: Vec::new(),
            deadlines: Vec::new(),
            reconnect: Vec::new(),
            canceled: Vec::new(),
            next_conn: 0,
            live_conn: None,
        };
        let initial = harness.remote.take();
        harness.pump(initial);
        harness.deliver_responses();
        harness
    }

    fn feed(&mut self, event: Event) {
        let commands = self.remote.handle(event);
        self.pump(commands);
        self.deliver_responses();
    }

    fn deliver_responses(&mut self) {
        loop {
            let responses = std::mem::take(&mut self.shared.lock().unwrap().responses);
            if responses.is_empty() {
                return;
            }
            let Some(conn) = self.live_conn else { return };
            for text in responses {
                let commands = self.remote.handle(Event::SocketData {
                    conn,
                    bytes: text.into_bytes(),
                });
                self.pump(commands);
            }
        }
    }

    fn pump(&mut self, commands: Vec<Command>) {
        let mut queue: VecDeque<Command> = commands.into();
        while let Some(command) = queue.pop_front() {
            match command {
                Command::OpenConnection { conn, .. } => {
                    self.next_conn = conn;
                    self.live_conn = Some(conn);
                    let silent = self
                        .shared
                        .lock()
                        .unwrap()
                        .opens
                        .last()
                        .map(|open| open.script.silent_open)
                        .unwrap_or(false);
                    if !silent {
                        queue.extend(self.remote.handle(Event::SocketOpened { conn }));
                    }
                }
                Command::SendBytes { .. } => {}
                Command::CloseSocket { conn } => {
                    if self.live_conn == Some(conn) {
                        self.live_conn = None;
                    }
                }
                Command::ScheduleReconnect { timer, delay_ms } => {
                    self.reconnect.push((timer, delay_ms))
                }
                Command::CancelReconnect { timer } => {
                    self.reconnect.retain(|(armed, _)| *armed != timer);
                    self.canceled.push(timer);
                }
                Command::ScheduleDeadline { timer, delay_ms } => {
                    self.deadlines.push((timer, delay_ms))
                }
                Command::CancelDeadline { timer } => {
                    self.deadlines.retain(|(armed, _)| *armed != timer);
                    self.canceled.push(timer);
                }
                Command::Ready { outcome } => self.ready = Some(outcome),
                Command::CandidateFailed { failure } => self.failures.push(failure),
                Command::EndpointSet {
                    host_key,
                    url,
                    endpoint_set,
                } => {
                    self.endpoints.push((host_key, url, endpoint_set));
                }
                Command::Paired {
                    url,
                    host_key,
                    private_key,
                    endpoint_set,
                } => {
                    self.paired.push((url, host_key, private_key, endpoint_set));
                }
                Command::ViewChanged
                | Command::OperationSucceeded { .. }
                | Command::OperationFailed { .. }
                | Command::RtcSignalOnly { .. }
                | Command::CreateRtcPeer { .. }
                | Command::AcceptRtcAnswer { .. }
                | Command::RtcSend { .. }
                | Command::CloseRtcPeer { .. } => {}
            }
        }
    }

    fn fire_latest_deadline(&mut self) {
        let (timer, _) = self.deadlines.pop().expect("a staged deadline");
        self.feed(Event::TimerFired { timer });
    }

    fn fire_round_deadline(&mut self) {
        let (timer, _) = self.deadlines.first().copied().expect("a round deadline");
        self.deadlines.retain(|(armed, _)| *armed != timer);
        self.feed(Event::TimerFired { timer });
    }

    fn close_live(&mut self, code: u16, reason: Option<&str>) {
        let conn = self.live_conn.take().expect("a live conn");
        self.feed(Event::SocketClosed {
            conn,
            code,
            reason: reason.map(|r| r.to_string()),
        });
    }

    fn opened_urls(&self) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .opens
            .iter()
            .map(|open| open.url.clone())
            .collect()
    }

    fn opened_pairing(&self) -> Vec<bool> {
        self.shared
            .lock()
            .unwrap()
            .opens
            .iter()
            .map(|open| open.paired)
            .collect()
    }

    fn connection(&self) -> String {
        self.remote
            .view()
            .and_then(|view| view.get("connection").cloned())
            .and_then(|value| value.as_str().map(|s| s.to_string_lossy()))
            .unwrap_or_default()
    }
}

fn loopback() -> RemoteCandidate {
    RemoteCandidate {
        url: "ws://127.0.0.1:7420/secure".to_string(),
        role: RemoteCandidateRole::Loopback,
        unsupported: None,
    }
}

fn relay(url: &str) -> RemoteCandidate {
    RemoteCandidate {
        url: url.to_string(),
        role: RemoteCandidateRole::Relay,
        unsupported: None,
    }
}

fn direct(url: &str) -> RemoteCandidate {
    RemoteCandidate {
        url: url.to_string(),
        role: RemoteCandidateRole::Direct,
        unsupported: None,
    }
}

#[test]
fn walks_candidates_in_auto_order_and_shares_one_pairing_until_message2() {
    let candidates = vec![loopback(), relay("wss://relay/"), direct("wss://direct/")];
    let h = Harness::new(
        candidates,
        vec![
            (loopback().url.as_str(), vec![Script::rejected(1006)]),
            (
                "wss://relay/",
                vec![Script {
                    auth: false,
                    hello: None,
                    close: Some(1006),
                    silent_open: false,
                    answer_sync: false,
                }],
            ),
            ("wss://direct/", vec![Script::healthy()]),
        ],
        true,
    );
    // The relay closes before message 2, so it never spends the invite.
    assert_eq!(
        h.opened_urls(),
        vec![
            loopback().url,
            "wss://relay/".to_string(),
            "wss://direct/".to_string()
        ]
    );
    // The direct is the first channel to verify message 2, so every open
    // before it shares the invite and no later candidate exists.
    assert_eq!(h.opened_pairing(), vec![true, true, true]);
    assert_eq!(h.shared.lock().unwrap().paired_calls, 1);
    assert_eq!(h.paired.len(), 1);
    assert!(matches!(h.ready, Some(ReadyOutcome::Connected)));
    assert_eq!(h.connection(), "connected");
}

#[test]
fn a_message2_lost_before_hello_retries_with_the_device_identity() {
    let candidates = vec![relay("wss://one/"), relay("wss://two/")];
    let h = Harness::new(
        candidates,
        vec![
            (
                "wss://one/",
                vec![Script {
                    auth: true,
                    hello: None,
                    close: Some(1006),
                    silent_open: false,
                    answer_sync: false,
                }],
            ),
            ("wss://two/", vec![Script::healthy()]),
        ],
        true,
    );
    assert_eq!(h.opened_pairing(), vec![true, false]);
    assert_eq!(h.shared.lock().unwrap().paired_calls, 1);
    assert!(matches!(h.ready, Some(ReadyOutcome::Connected)));
}

#[test]
fn stage_deadlines_are_finite_and_bound_to_the_candidate_generation() {
    let candidates = vec![
        relay("wss://open/"),
        relay("wss://noise/"),
        relay("wss://hello/"),
        relay("wss://sync/"),
        direct("wss://direct/"),
    ];
    let mut h = Harness::new(
        candidates,
        vec![
            ("wss://open/", vec![Script::open_timeout()]),
            ("wss://noise/", vec![Script::noise_timeout()]),
            ("wss://hello/", vec![Script::hello_timeout()]),
            ("wss://sync/", vec![Script::sync_timeout()]),
            ("wss://direct/", vec![Script::healthy()]),
        ],
        false,
    );
    // Each timeout retires exactly its own candidate and walks on.
    h.fire_latest_deadline();
    h.fire_latest_deadline();
    h.fire_latest_deadline();
    h.fire_latest_deadline();
    let stages: Vec<_> = h.failures.iter().map(|failure| failure.stage).collect();
    assert_eq!(
        stages,
        vec![
            CandidateFailureStage::Open,
            CandidateFailureStage::Noise,
            CandidateFailureStage::Hello,
            CandidateFailureStage::Sync,
        ]
    );
    assert_eq!(
        h.opened_urls().last().map(String::as_str),
        Some("wss://direct/")
    );
    assert_eq!(h.connection(), "connected");
}

#[test]
fn a_retired_batch_never_touches_the_successor() {
    let candidates = vec![relay("wss://bad/"), direct("wss://good/")];
    let h = Harness::new(
        candidates,
        vec![
            (
                "wss://bad/",
                vec![Script {
                    auth: true,
                    hello: Some(malformed_hello()),
                    close: Some(1006),
                    silent_open: false,
                    answer_sync: false,
                }],
            ),
            ("wss://good/", vec![Script::healthy()]),
        ],
        false,
    );
    assert_eq!(h.opened_urls(), vec!["wss://bad/".to_string(), "wss://good/".to_string()]);
    assert_eq!(h.connection(), "connected");
    assert!(matches!(h.ready, Some(ReadyOutcome::Connected)));
    assert_eq!(h.failures.len(), 1, "the successor's Closed must be dropped");
}

#[test]
fn late_events_and_cancelled_timers_from_a_retired_candidate_are_ignored() {
    let candidates = vec![relay("wss://slow/"), direct("wss://direct/")];
    let mut h = Harness::new(
        candidates,
        vec![
            ("wss://slow/", vec![Script::noise_timeout()]),
            ("wss://direct/", vec![Script::healthy()]),
        ],
        false,
    );
    let retired_timer = h.deadlines.last().copied().expect("stage deadline").0;
    let retired_conn = h.live_conn.expect("first conn");
    h.fire_latest_deadline();
    assert_eq!(h.connection(), "connected");
    // A late timer or socket event for the retired generation cannot move
    // the ready connection or open another candidate.
    let before = h.opened_urls().len();
    h.feed(Event::TimerFired {
        timer: retired_timer,
    });
    h.feed(Event::SocketClosed {
        conn: retired_conn,
        code: 1006,
        reason: None,
    });
    assert_eq!(h.opened_urls().len(), before);
    assert_eq!(h.connection(), "connected");
}

#[test]
fn only_a_round_whose_every_dialed_path_was_unauthorized_is_revoked() {
    let all = vec![relay("wss://one/"), direct("wss://two/")];
    let h = Harness::new(
        all,
        vec![
            ("wss://one/", vec![Script::rejected(4401)]),
            ("wss://two/", vec![Script::rejected(4401)]),
        ],
        false,
    );
    assert_eq!(h.ready, Some(ReadyOutcome::Unauthorized));
    assert_eq!(h.shared.lock().unwrap().opens.len(), 2);

    let mixed = vec![relay("wss://one/"), direct("wss://two/")];
    let h = Harness::new(
        mixed,
        vec![
            ("wss://one/", vec![Script::rejected(4401)]),
            ("wss://two/", vec![Script::rejected(1006)]),
        ],
        false,
    );
    match h.ready {
        Some(ReadyOutcome::Error(message)) => {
            assert!(message.contains("close 4401"));
            assert!(message.contains("close 1006"));
        }
        other => panic!("expected an aggregate error, got {other:?}"),
    }
}

#[test]
fn an_authenticated_protocol_mismatch_stops_the_whole_round() {
    let candidates = vec![relay("wss://one/"), direct("wss://two/")];
    let h = Harness::new(
        candidates,
        vec![
            (
                "wss://one/",
                vec![Script {
                    auth: true,
                    hello: Some(hello(None, PROTOCOL.major as f64 + 1.0)),
                    close: None,
                    silent_open: false,
                    answer_sync: false,
                }],
            ),
            ("wss://two/", vec![Script::healthy()]),
        ],
        false,
    );
    assert!(matches!(h.ready, Some(ReadyOutcome::Mismatch { .. })));
    assert_eq!(h.opened_urls(), vec!["wss://one/".to_string()]);
}

#[test]
fn an_unsupported_candidate_is_skipped_not_counted_as_a_host_failure() {
    let candidates = vec![
        RemoteCandidate {
            url: "ws://relay/".to_string(),
            role: RemoteCandidateRole::Relay,
            unsupported: Some("mixed content".to_string()),
        },
        direct("wss://direct/"),
    ];
    let h = Harness::new(
        candidates,
        vec![("wss://direct/", vec![Script::healthy()])],
        false,
    );
    assert_eq!(h.opened_urls(), vec!["wss://direct/".to_string()]);
    assert_eq!(h.failures.len(), 1);
    assert_eq!(h.failures[0].stage, CandidateFailureStage::Unsupported);
    assert!(!h.failures[0].unauthorized);
    assert_eq!(h.connection(), "connected");
}

fn endpoint_set(entries: &[(HostEndpointRole, &str)]) -> EndpointSet {
    EndpointSet {
        schema_version: 1,
        endpoints: entries
            .iter()
            .map(|(role, url)| HostEndpoint {
                role: *role,
                url: U16String::from_str(url),
            })
            .collect(),
    }
}

#[test]
fn a_hello_endpoint_set_owns_the_next_round_and_updates_the_stored_legacy_url() {
    let learned = endpoint_set(&[
        (HostEndpointRole::Relay, "wss://new-relay/"),
        (HostEndpointRole::Direct, "wss://new-direct/"),
    ]);
    let candidates = vec![relay("wss://old/")];
    let mut h = Harness::new(
        candidates,
        vec![
            (
                "wss://old/",
                vec![Script {
                    auth: true,
                    hello: Some(hello(Some(learned.clone()), PROTOCOL.major as f64)),
                    close: None,
                    silent_open: false,
                    answer_sync: true,
                }],
            ),
            ("wss://new-relay/", vec![Script::healthy()]),
        ],
        false,
    );
    assert_eq!(h.connection(), "connected");
    assert_eq!(h.endpoints.len(), 1);
    assert_eq!(h.endpoints[0].1, "wss://new-relay/");
    h.close_live(1006, None);
    assert_eq!(
        h.opened_urls(),
        vec!["wss://old/".to_string(), "wss://new-relay/".to_string()]
    );
    assert_eq!(h.connection(), "connected");
}

#[test]
fn an_explicit_empty_remote_set_keeps_a_client_local_loopback() {
    let empty = endpoint_set(&[]);
    let candidates = vec![loopback()];
    let mut h = Harness::new(
        candidates,
        vec![(
            loopback().url.as_str(),
            vec![Script {
                auth: true,
                hello: Some(hello(Some(empty), PROTOCOL.major as f64)),
                close: None,
                silent_open: false,
                answer_sync: true,
            }],
        )],
        false,
    );
    assert_eq!(h.endpoints[0].2.endpoints.len(), 0);
    h.close_live(1006, None);
    assert_eq!(h.opened_urls(), vec![loopback().url, loopback().url]);
    assert_eq!(h.connection(), "connected");
}

#[test]
fn the_whole_round_budget_is_a_hard_stop() {
    let candidates = vec![relay("wss://one/"), direct("wss://two/")];
    let mut h = Harness::with_timeouts(
        candidates,
        vec![
            ("wss://one/", vec![Script::open_timeout()]),
            ("wss://two/", vec![Script::open_timeout()]),
        ],
        false,
        CandidateTimeouts {
            socket_open_ms: 500,
            noise_ms: 500,
            hello_ms: 500,
            sync_ms: 500,
        },
        Some(50),
    );
    h.fire_round_deadline();
    let failure = h.failures.first().expect("the round failure is recorded");
    assert_eq!(failure.stage, CandidateFailureStage::Round);
    match &h.ready {
        Some(ReadyOutcome::Error(message)) => assert!(message.contains("round exceeded 50ms")),
        other => panic!("expected a round error, got {other:?}"),
    }
}

#[test]
fn a_failed_round_backs_off_and_network_change_starts_a_new_round() {
    let candidates = vec![relay("wss://one/"), direct("wss://two/")];
    let mut h = Harness::new(
        candidates,
        vec![
            (
                "wss://one/",
                vec![Script::healthy(), Script::open_timeout(), Script::healthy()],
            ),
            ("wss://two/", vec![Script::open_timeout()]),
        ],
        false,
    );
    assert_eq!(h.connection(), "connected");
    h.close_live(1006, None);
    h.fire_latest_deadline();
    h.fire_latest_deadline();
    assert_eq!(h.reconnect.len(), 1);
    let before = h.opened_urls().len();
    h.feed(Event::NetworkChanged);
    assert!(h.canceled.len() > 0);
    assert!(h.opened_urls().len() > before);
    assert_eq!(h.connection(), "connected");
}
