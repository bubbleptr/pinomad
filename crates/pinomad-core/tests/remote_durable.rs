// remote-durable.test.ts ported to the state machine: a scripted host on the
// other end of the event/command loop (the test file's `fakeTransport`),
// deterministic events, no sleeps.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use pinomad_core::frames::{ApnsEnvironment, ApnsPushToken, PROTOCOL};
use pinomad_core::json::{Json, JsonObject};
use pinomad_core::remote_durable::{
    Call, Command, Event, ForkShow, ReadyOutcome, RemoteDurable, RemoteDurableOptions,
};
use pinomad_core::transport::{PlaintextTransport, Transport};
use pinomad_core::u16str::U16String;

const DOC_KIND: &str = "pinomad.question";

fn obj(fields: &[(&str, Json)]) -> Json {
    let mut object = JsonObject::new();
    for (name, value) in fields {
        object.set(U16String::from_str(name), value.clone());
    }
    Json::Object(Arc::new(object))
}

fn default_snapshots() -> HashMap<String, Json> {
    let mut snapshots = HashMap::new();
    snapshots.insert("conversations".to_string(), Json::array(vec![]));
    snapshots.insert("index".to_string(), obj(&[("projects", Json::array(vec![])), ("conversations", Json::array(vec![]))]));
    snapshots.insert("devices".to_string(), obj(&[("devices", Json::array(vec![]))]));
    snapshots.insert("tasks".to_string(), obj(&[("tasks", obj(&[]))]));
    snapshots.insert("mcp".to_string(), Json::Null);
    snapshots.insert(
        "models".to_string(),
        Json::array(vec![obj(&[
            ("provider", Json::from("streamp")),
            ("modelId", Json::from("stream-1")),
            ("name", Json::from("Stream One")),
            ("contextWindow", Json::from(8000.0)),
            ("thinkingLevels", Json::array(vec![Json::from("off")])),
        ])]),
    );
    snapshots.insert(
        "auth".to_string(),
        obj(&[("logins", Json::array(vec![obj(&[
            ("providerId", Json::from("streamp")),
            ("name", Json::from("Stream Provider")),
            ("kind", Json::from("api_key")),
            ("subscription", Json::from(false)),
        ])]))]),
    );
    snapshots.insert(
        "settings".to_string(),
        obj(&[
            ("defaultModel", obj(&[("provider", Json::from("streamp")), ("modelId", Json::from("stream-1"))])),
            ("defaultThinkingLevel", Json::from("high")),
            ("steeringMode", Json::from("all")),
            ("followUpMode", Json::from("all")),
            ("custom", Json::array(vec![
                Json::from("defaultModel"),
                Json::from("defaultThinkingLevel"),
                Json::from("steeringMode"),
                Json::from("followUpMode"),
            ])),
        ]),
    );
    snapshots.insert("agents".to_string(), obj(&[("roles", Json::array(vec![])), ("problems", Json::array(vec![]))]));
    snapshots
}

fn snapshot_for(stream: &str, snapshots: &HashMap<String, Json>) -> Json {
    if let Some(value) = snapshots.get(stream) {
        return value.clone();
    }
    if let Some(rest) = stream.strip_prefix("conversation:") {
        let id: f64 = rest.parse().unwrap_or(f64::NAN);
        return obj(&[
            ("conversation", obj(&[("id", Json::Number(id))])),
            ("entries", Json::array(vec![])),
        ]);
    }
    if stream.starts_with("doc:") {
        return obj(&[("requests", Json::array(vec![]))]);
    }
    Json::Null
}

fn base_hello(protocol: Json, defaults: Json) -> Json {
    obj(&[
        ("type", Json::from("hello")),
        ("protocol", protocol),
        ("session", obj(&[("id", Json::from("fake")), ("directory", Json::from(""))])),
        ("models", Json::array(vec![])),
        ("docs", Json::array(vec![obj(&[
            ("kind", Json::from(DOC_KIND)),
            ("presentation", Json::from(DOC_KIND)),
        ])])),
        ("toolPresentations", obj(&[])),
        ("defaults", defaults),
    ])
}

fn merge_hello(base: &Json, extras: &[(String, Json)]) -> Json {
    let mut object = base.as_object().expect("hello").as_ref().clone();
    for (name, value) in extras {
        object.set(U16String::from_str(name), value.clone());
    }
    Json::Object(Arc::new(object))
}

fn protocol_obj(minor: f64) -> Json {
    obj(&[("major", Json::from(5.0)), ("minor", Json::from(minor))])
}

/// The TS `fakeTransport`: answers every subscribe with a snapshot, answers
/// calls ok (fork mints `conversationId + 1`), records client frames in
/// `sent`, and says hello with `defaults_list[n]` for connection n.
struct ScriptedHost {
    defaults_list: Vec<Json>,
    hello_extras: Vec<(String, Json)>,
    snapshots: HashMap<String, Json>,
    held: HashSet<String>,
    sent: Vec<Json>,
    conn: u32,
    opened: u32,
    call_errors: HashMap<String, String>,
    call_results: HashMap<String, Json>,
    /// Calls recorded but never answered — pending calls on the client.
    hang_calls: bool,
    /// Calls to these methods are recorded but never answered.
    hung_methods: HashSet<String>,
}

impl ScriptedHost {
    fn new(defaults_list: Vec<Json>, hello_extras: Vec<(String, Json)>) -> Self {
        ScriptedHost {
            defaults_list,
            hello_extras,
            snapshots: default_snapshots(),
            held: HashSet::new(),
            sent: Vec::new(),
            conn: 0,
            opened: 0,
            call_errors: HashMap::new(),
            call_results: HashMap::new(),
            hang_calls: false,
            hung_methods: HashSet::new(),
        }
    }

    fn hello(&self) -> String {
        let index = (self.opened as usize).saturating_sub(1).min(self.defaults_list.len().saturating_sub(1));
        let defaults = self.defaults_list.get(index).cloned().unwrap_or_else(|| obj(&[]));
        // ScriptedHost always answers at the build's own protocol minor —
        // follow PROTOCOL so a 5.x bump needs no edits here.
        merge_hello(&base_hello(protocol_obj(PROTOCOL.minor as f64), defaults), &self.hello_extras).to_json()
    }

    /// Client frame in, any server frames out.
    fn receive(&mut self, text: &str) -> Vec<String> {
        let frame = Json::parse(text).expect("client frame JSON");
        self.sent.push(frame.clone());
        let Some(frame_type) = frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()) else {
            return vec![];
        };
        match frame_type.as_str() {
            "subscribe" => {
                let stream = frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
                if self.held.contains(&stream) {
                    return vec![];
                }
                let value = snapshot_for(&stream, &self.snapshots);
                vec![obj(&[
                    ("type", Json::from("snapshot")),
                    ("stream", frame.get("stream").cloned().unwrap_or(Json::Null)),
                    ("value", value),
                ]).to_json()]
            }
            "call" => {
                let method = frame.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
                if self.hang_calls || self.hung_methods.contains(&method) {
                    return vec![];
                }
                let id = frame.get("id").cloned().unwrap_or(Json::Null);
                let value = if let Some(configured) = self.call_results.get(&method) {
                    configured.clone()
                } else if method == "fork" {
                    let conversation = frame
                        .get("args")
                        .and_then(|args| args.get("conversationId"))
                        .and_then(Json::as_number)
                        .unwrap_or(0.0);
                    obj(&[("conversationId", Json::Number(conversation + 1.0))])
                } else {
                    Json::Null
                };
                let result = if let Some(error) = self.call_errors.get(&method) {
                    obj(&[
                        ("type", Json::from("result")),
                        ("id", id),
                        ("ok", Json::Bool(false)),
                        ("error", Json::from(error.clone())),
                    ])
                } else {
                    obj(&[
                        ("type", Json::from("result")),
                        ("id", id),
                        ("ok", Json::Bool(true)),
                        ("value", value),
                    ])
                };
                vec![result.to_json()]
            }
            _ => vec![],
        }
    }

    fn subscribes(&self) -> Vec<String> {
        self.sent
            .iter()
            .filter(|frame| frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy() == "subscribe").unwrap_or(false))
            .map(|frame| frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default())
            .collect()
    }

    /// The last subscribe frame for `stream`, with its optional ref mode.
    fn subscription(&self, stream: &str) -> Option<Json> {
        self.sent.iter().rev().find(|frame| {
            frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy() == "subscribe").unwrap_or(false)
                && frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()) == Some(stream.to_string())
        }).cloned()
    }

    fn unsubscribes(&self) -> Vec<String> {
        self.sent
            .iter()
            .filter(|frame| frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy() == "unsubscribe").unwrap_or(false))
            .map(|frame| frame.get("stream").and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default())
            .collect()
    }

    fn calls(&self) -> Vec<Json> {
        self.sent
            .iter()
            .filter(|frame| frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy() == "call").unwrap_or(false))
            .cloned()
            .collect()
    }

    fn method(&self, name: &str) -> Vec<Json> {
        self.calls()
            .into_iter()
            .filter(|frame| frame.get("method").and_then(Json::as_str).map(|s| s.to_string_lossy() == name).unwrap_or(false))
            .collect()
    }
}

struct Harness {
    remote: RemoteDurable,
    host: ScriptedHost,
    ready: Option<ReadyOutcome>,
    ops: HashMap<u64, Result<Option<Json>, String>>,
    views: usize,
    paired: bool,
    timers: Vec<(u32, u64)>,
    canceled: Vec<u32>,
}

impl Harness {
    fn new(host: ScriptedHost) -> Self {
        Self::with_options(host, (20, 20))
    }

    fn with_options(host: ScriptedHost, delays: (u64, u64)) -> Self {
        let mut harness = Harness {
            remote: RemoteDurable::new(RemoteDurableOptions {
                transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
                reconnect_delay_ms: Some(delays),
                request_id: Some(Box::new({
                    let mut n = 0u64;
                    move || {
                        n += 1;
                        format!("request-{n}")
                    }
                })),
            }),
            host,
            ready: None,
            ops: HashMap::new(),
            views: 0,
            paired: false,
            timers: Vec::new(),
            canceled: Vec::new(),
        };
        let initial = harness.remote.take();
        harness.pump(initial);
        harness
    }

    /// Feed an event, then run the command/event loop until it settles —
    /// every command is executed and any server frames it produces go back
    /// in as events, exactly like the transport wiring.
    fn handle(&mut self, event: Event) {
        let commands = self.remote.handle(event);
        self.pump(commands);
    }

    fn pump(&mut self, commands: Vec<Command>) {
        let mut queue: VecDeque<Command> = commands.into();
        while let Some(command) = queue.pop_front() {
            match command {
                Command::OpenConnection { conn, .. } => {
                    self.host.conn = conn;
                    self.host.opened += 1;
                    queue.extend(self.remote.handle(Event::SocketOpened { conn }));
                    let hello = self.host.hello();
                    queue.extend(self.remote.handle(Event::SocketData { conn, bytes: hello.into_bytes() }));
                }
                Command::SendBytes { conn, bytes } => {
                    let replies = self.host.receive(std::str::from_utf8(&bytes).expect("client frame"));
                    for reply in replies {
                        queue.extend(self.remote.handle(Event::SocketData { conn, bytes: reply.into_bytes() }));
                    }
                }
                Command::CloseSocket { conn } => {
                    queue.extend(self.remote.handle(Event::SocketClosed { conn, code: 1000, reason: None }));
                }
                Command::ScheduleReconnect { timer, delay_ms } => self.timers.push((timer, delay_ms)),
                Command::CancelReconnect { timer } => {
                    self.timers.retain(|(armed, _)| *armed != timer);
                    self.canceled.push(timer);
                }
                Command::Ready { outcome } => self.ready = Some(outcome),
                Command::ViewChanged => self.views += 1,
                Command::Paired { .. } => self.paired = true,
                Command::OperationSucceeded { op, value } => {
                    self.ops.insert(op, Ok(value));
                }
                Command::OperationFailed { op, error } => {
                    self.ops.insert(op, Err(error));
                }
            }
        }
    }

    /// Server closes the socket — `disconnect()` in the TS fake.
    fn disconnect(&mut self, code: u16, reason: Option<&str>) {
        let conn = self.host.conn;
        self.handle(Event::SocketClosed { conn, code, reason: reason.map(|r| r.to_string()) });
    }

    /// Fire the most recent reconnect timer.
    fn fire_timer(&mut self) {
        let (timer, _) = *self.timers.last().expect("no timer scheduled");
        self.timers.pop();
        self.handle(Event::TimerFired { timer });
    }

    fn invoke(&mut self, op: u64, call: Call) {
        self.handle(Event::Invoke { op, call });
    }

    /// A server frame delivered out of band (like `opened[i].message(...)`).
    fn deliver(&mut self, frame: Json) {
        let conn = self.host.conn;
        let text = frame.to_json();
        self.handle(Event::SocketData { conn, bytes: text.into_bytes() });
    }

    fn view(&self) -> Json {
        self.remote.view().expect("view")
    }

    /// `view.a.b.c` without the borrow dance — returns a cloned Json.
    fn dig(&self, path: &[&str]) -> Option<Json> {
        let mut current = self.view();
        for name in path {
            current = current.get(name)?.clone();
        }
        Some(current)
    }

    fn view_get(&self, name: &str) -> Option<Json> {
        self.view().get(name).cloned()
    }

    fn connection(&self) -> String {
        self.view_get("connection")
            .and_then(|v| v.as_str().map(|s| s.to_string_lossy()))
            .unwrap_or_default()
    }

    fn notices(&self) -> Vec<Json> {
        self.view_get("notices").and_then(|v| v.as_array().map(|a| a.as_ref().clone())).unwrap_or_default()
    }

    fn last_notice(&self) -> Json {
        self.notices().last().cloned().unwrap_or(Json::Null)
    }
}

fn setup() -> Harness {
    let host = ScriptedHost::new(vec![obj(&[])], vec![]);
    let harness = Harness::new(host);
    assert_eq!(harness.ready, Some(ReadyOutcome::Connected));
    harness
}

// ─── reconnect ────────────────────────────────────────────────────────

#[test]
fn reconnect_hello_defaults_beat_the_first_hellos() {
    let second = obj(&[
        ("model", obj(&[("provider", Json::from("faux")), ("modelId", Json::from("faux-2"))])),
        ("thinkingLevel", Json::from("low")),
    ]);
    let host = ScriptedHost::new(
        vec![obj(&[]), second],
        vec![("protocol".to_string(), protocol_obj(1.0))],
    );
    let mut h = Harness::new(host);
    assert_eq!(h.view_get("defaults"), Some(obj(&[])));

    h.disconnect(1000, None);
    assert_eq!(h.connection(), "reconnecting");
    h.fire_timer();
    assert_eq!(h.connection(), "connected");
    assert_eq!(
        h.dig(&["defaults", "model", "modelId"]),
        Some(Json::from("faux-2"))
    );
}

#[test]
fn unknown_frame_types_are_ignored() {
    let mut h = setup();
    h.deliver(obj(&[("type", Json::from("from-the-future")), ("data", Json::from(1.0))]));
    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("mcp")),
        ("value", obj(&[("servers", Json::array(vec![]))])),
    ]));
    assert_eq!(h.connection(), "connected");
    assert_eq!(h.view_get("mcp"), Some(obj(&[("servers", Json::array(vec![]))])));
}

#[test]
fn close_4400_is_terminal_after_ready() {
    let mut h = setup();
    h.disconnect(4400, Some("Invalid client frame"));
    assert_eq!(h.connection(), "closed");
    let message = h.last_notice().get("message").and_then(Json::as_str).unwrap().to_string_lossy();
    assert!(message.contains("malformed"));
    assert!(message.contains("Invalid client frame"));
    // No reconnect timer armed.
    assert!(h.timers.is_empty());
    assert_eq!(h.host.opened, 1);
}

#[test]
fn close_1008_reconnects() {
    let mut h = setup();
    h.disconnect(1008, Some("handshake timeout"));
    assert_eq!(h.connection(), "reconnecting");
    h.fire_timer();
    assert_eq!(h.connection(), "connected");
    assert_eq!(h.host.opened, 2);
}

// ─── lifecycle hints (ADR-0024 §3, native only — the reference has no
// equivalent) ────────────────────────────────────────────────────────

#[test]
fn foreground_reconnects_immediately_and_resets_the_backoff() {
    // delays (20, 80): first loss arms 20, a second loss would arm 40 —
    // the reset shows the counter went back to zero.
    let host = ScriptedHost::new(vec![obj(&[])], vec![]);
    let mut h = Harness::with_options(host, (20, 80));
    h.disconnect(1006, None);
    let (timer, delay) = h.timers.last().copied().expect("backoff armed");
    assert_eq!(delay, 20);
    h.handle(Event::Foreground);
    assert!(h.canceled.contains(&timer));
    assert!(h.timers.is_empty());
    // A fresh generation opened right away — no TimerFired needed.
    assert_eq!(h.host.opened, 2);
    assert_eq!(h.connection(), "connected");
    // The backoff counter reset: the next loss re-arms at the minimum.
    h.disconnect(1006, None);
    assert_eq!(h.timers.last().map(|(_, delay)| *delay), Some(20));
}

#[test]
fn network_changed_reconnects_immediately() {
    let mut h = setup();
    h.disconnect(1006, None);
    let (timer, _) = h.timers.last().copied().expect("backoff armed");
    h.handle(Event::NetworkChanged);
    assert!(h.canceled.contains(&timer));
    assert_eq!(h.host.opened, 2);
    assert_eq!(h.connection(), "connected");
}

#[test]
fn background_leaves_the_backoff_timer_armed() {
    let mut h = setup();
    h.disconnect(1006, None);
    h.handle(Event::Background);
    assert_eq!(h.host.opened, 1);
    assert_eq!(h.timers.len(), 1);
    h.fire_timer();
    assert_eq!(h.host.opened, 2);
}

#[test]
fn lifecycle_hints_do_not_disturb_live_or_terminal_states() {
    // Connected: nothing to cut short.
    let mut h = setup();
    h.handle(Event::Foreground);
    h.handle(Event::NetworkChanged);
    h.handle(Event::Background);
    assert_eq!(h.host.opened, 1);
    // Terminal (explicit Close): no resurrection.
    h.handle(Event::Close);
    assert_eq!(h.connection(), "closed");
    h.handle(Event::Foreground);
    h.handle(Event::NetworkChanged);
    assert_eq!(h.host.opened, 1);
    // Terminal (4401): same.
    let mut h = setup();
    h.disconnect(4401, None);
    h.handle(Event::Foreground);
    assert_eq!(h.host.opened, 1);
    // Still connecting (OpenConnection emitted, not yet answered): the
    // conn exists but there is no timer to cancel.
    let mut remote = RemoteDurable::new(RemoteDurableOptions {
        transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
        reconnect_delay_ms: None,
        request_id: None,
    });
    remote.take();
    assert!(remote.handle(Event::Foreground).is_empty());
    assert!(remote.handle(Event::NetworkChanged).is_empty());
}

#[test]
fn close_while_backing_off_cancels_the_timer() {
    let mut h = setup();
    h.disconnect(1006, None);
    let (timer, _) = h.timers.last().copied().expect("backoff armed");
    h.handle(Event::Close);
    assert!(h.canceled.contains(&timer));
    assert_eq!(h.connection(), "closed");
    // And the dead timer no longer reconnects.
    h.handle(Event::TimerFired { timer });
    assert_eq!(h.host.opened, 1);
}

#[test]
fn close_4401_flags_unauthorized_and_4400_does_not() {
    for (code, expect_unauthorized) in [(4401u16, true), (4400u16, false)] {
        let mut h = setup();
        h.disconnect(code, None);
        assert_eq!(h.connection(), "closed");
        assert_eq!(
            h.view_get("unauthorized").map(|v| v == Json::Bool(true)).unwrap_or(false),
            expect_unauthorized
        );
    }
}

#[test]
fn close_4401_before_ready_rejects_unauthorized() {
    let _host = ScriptedHost::new(vec![obj(&[])], vec![]);
    let mut remote = RemoteDurable::new(RemoteDurableOptions {
        transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
        reconnect_delay_ms: None,
        request_id: None,
    });
    let commands = remote.handle(Event::SocketClosed { conn: 1, code: 4401, reason: None });
    let ready = commands
        .iter()
        .find_map(|command| match command {
            Command::Ready { outcome } => Some(outcome.clone()),
            _ => None,
        })
        .expect("ready outcome");
    assert_eq!(ready, ReadyOutcome::Unauthorized);
}

// ─── image refs (5.15, ADR-0027) ─────────────────────────────────────

fn has_ref_mode(frame: Option<&Json>) -> bool {
    frame.and_then(|f| f.get("images")).and_then(Json::as_str).map(|s| s.to_string_lossy()) == Some("ref".to_string())
}

#[test]
fn a_5_15_host_gets_ref_subs_for_conversations_only() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    assert!(has_ref_mode(h.host.subscription("conversation:1").as_ref()));
    // Host streams and doc streams predate refs; the flag is a
    // conversation-stream contract only.
    assert!(!has_ref_mode(h.host.subscription("conversations").as_ref()));
    assert!(!has_ref_mode(h.host.subscription("settings").as_ref()));
    assert!(!has_ref_mode(h.host.subscription(&format!("doc:{DOC_KIND}:1")).as_ref()));
    assert!(!has_ref_mode(h.host.subscription("tasks").as_ref()));
}

#[test]
fn a_5_14_host_gets_no_ref_subs() {
    let host = ScriptedHost::new(
        vec![obj(&[])],
        vec![("protocol".to_string(), protocol_obj(14.0))],
    );
    let mut h = Harness::new(host);
    h.invoke(1, Call::SwitchConversation { id: 1 });
    assert!(!has_ref_mode(h.host.subscription("conversation:1").as_ref()));
}

#[test]
fn reconnect_resubscribes_a_conversation_with_refs() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    let before = h.host.subscribes().len();
    h.disconnect(1000, None);
    h.fire_timer();
    assert!(h.host.subscribes().len() > before);
    assert!(has_ref_mode(h.host.subscription("conversation:1").as_ref()));
}

#[test]
fn conversation_freshness_waits_for_the_reconnect_snapshot() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    assert!(h.remote.conversation_is_fresh());
    let epoch = h.remote.conversation_fresh_epoch();
    assert!(epoch > 0);

    // The hello re-sends the subscribe, but the host holds the fresh
    // conversation snapshot: the old view is still on screen while a ref
    // lookup would not resolve on the host yet.
    h.host.held.insert("conversation:1".to_string());
    h.disconnect(1000, None);
    h.fire_timer();
    assert!(h.host.subscribes().contains(&"conversation:1".to_string()));
    assert!(!h.remote.conversation_is_fresh());
    assert_eq!(h.remote.conversation_fresh_epoch(), epoch);

    h.host.held.clear();
    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("conversation:1")),
        ("value", obj(&[
            ("conversation", obj(&[("id", Json::from(1.0))])),
            ("entries", Json::array(vec![])),
        ])),
    ]));
    assert!(h.remote.conversation_is_fresh());
    assert_eq!(h.remote.conversation_fresh_epoch(), epoch + 1);
}

#[test]
fn ref_mode_follows_the_minor_of_each_hello() {
    // The first connection is 5.15, the reconnect announces 5.14: the
    // resent subscribe must drop the flag, not keep the stale decision.
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.disconnect(1000, None);
    h.host.hello_extras = vec![("protocol".to_string(), protocol_obj(14.0))];
    h.fire_timer();
    assert!(!has_ref_mode(h.host.subscription("conversation:1").as_ref()));
}

// ─── side conversation ────────────────────────────────────────────────

#[test]
fn shows_a_second_conversation_and_closes_it() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::ShowSide { id: Some(2) });

    assert!(h.host.subscribes().contains(&"conversation:2".to_string()));
    assert!(h.host.subscribes().contains(&format!("doc:{DOC_KIND}:2")));
    let side = h.view_get("side").expect("side");
    assert_eq!(side.get("id").and_then(Json::as_number), Some(2.0));
    assert_eq!(
        h.dig(&["side", "conversation", "conversation", "id"]).and_then(|v| v.as_number()),
        Some(2.0)
    );
    assert_eq!(h.dig(&["conversation", "conversation", "id"]).and_then(|v| v.as_number()), Some(1.0));

    h.invoke(3, Call::ShowSide { id: None });
    assert!(h.host.unsubscribes().contains(&"conversation:2".to_string()));
    assert!(h.view_get("side").is_none());
}

#[test]
fn side_shares_streams_with_main() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    let subscribed = h.host.subscribes().len();
    h.invoke(2, Call::ShowSide { id: Some(1) });
    assert_eq!(h.host.subscribes().len(), subscribed);
    assert_eq!(h.dig(&["side", "id"]), Some(Json::from(1.0)));

    h.invoke(3, Call::ShowSide { id: None });
    assert!(h.host.unsubscribes().is_empty());
}

#[test]
fn switching_onto_and_away_from_the_side_keeps_its_streams() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::ShowSide { id: Some(2) });
    let subscribed = h.host.subscribes().len();
    h.invoke(3, Call::SwitchConversation { id: 2 });
    assert_eq!(h.host.subscribes().len(), subscribed);
    h.invoke(4, Call::SwitchConversation { id: 3 });
    assert!(!h.host.unsubscribes().contains(&"conversation:2".to_string()));
    assert!(h.host.unsubscribes().contains(&"conversation:1".to_string()));
    assert_eq!(h.dig(&["side", "id"]), Some(Json::from(2.0)));
}

#[test]
fn submit_answer_and_abort_target_a_chosen_conversation() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::Submit {
        text: "to the side".to_string(),
        when_busy: "followUp".to_string(),
        target: Some(2),
        request_id: None,
        images: vec![],
    });
    h.invoke(3, Call::Answer {
        kind: DOC_KIND.to_string(),
        request_id: "req-1".to_string(),
        answers: Json::array(vec![obj(&[("selected", Json::array(vec![Json::from("yes")]))])]),
        target: Some(2),
    });
    h.invoke(4, Call::Abort { target: Some(2) });
    h.invoke(5, Call::Submit {
        text: "to the main".to_string(),
        when_busy: "followUp".to_string(),
        target: None,
        request_id: None,
        images: vec![],
    });
    let calls = h.host.calls();
    let methods: Vec<String> = calls
        .iter()
        .map(|frame| frame.get("method").and_then(Json::as_str).unwrap().to_string_lossy())
        .collect();
    assert_eq!(methods, ["submit", "answer", "abort", "submit"]);
    let targets: Vec<f64> = calls
        .iter()
        .map(|frame| frame.get("args").and_then(|a| a.get("conversationId")).and_then(Json::as_number).unwrap())
        .collect();
    assert_eq!(targets, [2.0, 2.0, 2.0, 1.0]);
}

#[test]
fn submit_sends_the_callers_request_id() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::Submit {
        text: "retry".to_string(),
        when_busy: "followUp".to_string(),
        target: Some(1),
        request_id: Some("retry:run-4".to_string()),
        images: vec![],
    });
    h.invoke(3, Call::Submit {
        text: "fresh".to_string(),
        when_busy: "followUp".to_string(),
        target: Some(1),
        request_id: None,
        images: vec![],
    });
    let submits = h.host.method("submit");
    assert_eq!(submits[0].get("args").and_then(|a| a.get("requestId")).and_then(Json::as_str).unwrap().to_string_lossy(), "retry:run-4");
    let generated = submits[1].get("args").and_then(|a| a.get("requestId")).and_then(Json::as_str).unwrap().to_string_lossy();
    assert!(!generated.is_empty() && generated != "retry:run-4");
}

#[test]
fn images_need_a_5_5_host() {
    let image = obj(&[("data", Json::from("aGVsbG8=")), ("mimeType", Json::from("image/png"))]);
    let submit = |images: Vec<Json>| Call::Submit {
        text: "look".to_string(),
        when_busy: "followUp".to_string(),
        target: None,
        request_id: None,
        images,
    };
    let old = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(4.0))]);
    let mut h = Harness::new(old);
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, submit(vec![image.clone()]));
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy().contains("needs protocol 5.5")).unwrap_or(false)
    }));
    assert!(h.host.method("submit").is_empty());
    assert!(matches!(h.ops.get(&2), Some(Ok(None))));

    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, submit(vec![image.clone()]));
    h.invoke(3, submit(vec![]));
    let submits = h.host.method("submit");
    assert_eq!(submits[0].get("args").and_then(|a| a.get("images")).cloned(), Some(Json::array(vec![image])));
    assert!(submits[1].get("args").and_then(|a| a.get("images")).is_none());
}

#[test]
fn image_refs_need_a_5_15_host() {
    let bytes = obj(&[("data", Json::from("aGVsbG8=")), ("mimeType", Json::from("image/png"))]);
    let reference = obj(&[("ref", Json::from("abc123"))]);
    // Inline bytes win over a ref on the same block, so this is a bytes form.
    let inline_with_ref = obj(&[
        ("data", Json::from("aGVsbG8=")),
        ("mimeType", Json::from("image/png")),
        ("ref", Json::from("ignored")),
    ]);
    let submit = |images: Vec<Json>| Call::Submit {
        text: "look".to_string(),
        when_busy: "followUp".to_string(),
        target: None,
        request_id: None,
        images,
    };
    let create = |images: Vec<Json>| Call::CreateConversation {
        home: obj(&[("kind", Json::from("chat"))]),
        text: "hi".to_string(),
        checkout: None,
        model: None,
        thinking_level: None,
        agent: None,
        images,
    };

    let old = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(14.0))]);
    let mut h = Harness::new(old);
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, submit(vec![reference.clone()]));
    // Mixed batches are refused too: the host would 4400 the ref entry.
    h.invoke(3, submit(vec![bytes.clone(), reference.clone()]));
    h.invoke(4, create(vec![reference.clone()]));
    let gated = h
        .notices()
        .iter()
        .filter(|notice| {
            notice
                .get("message")
                .and_then(Json::as_str)
                .is_some_and(|message| message.to_string_lossy().contains("needs protocol 5.15"))
        })
        .count();
    assert_eq!(gated, 3, "each ref-form call must be refused locally");
    assert!(h.host.method("submit").is_empty());
    assert!(h.host.method("createConversation").is_empty());
    // Bytes alone still reach a 5.14 host.
    h.invoke(5, submit(vec![bytes.clone()]));
    // So does a bytes block that happens to carry a ref: the data is the form.
    h.invoke(6, submit(vec![inline_with_ref.clone()]));
    h.invoke(7, create(vec![inline_with_ref.clone()]));
    let submits = h.host.method("submit");
    assert_eq!(submits.len(), 2);
    assert_eq!(
        submits[1].get("args").and_then(|a| a.get("images")).cloned(),
        Some(Json::array(vec![inline_with_ref.clone()]))
    );
    let creates = h.host.method("createConversation");
    assert_eq!(creates.len(), 1);
    assert_eq!(
        creates[0].get("args").and_then(|a| a.get("images")).cloned(),
        Some(Json::array(vec![inline_with_ref]))
    );

    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, submit(vec![reference.clone()]));
    h.invoke(3, create(vec![reference.clone()]));
    let submits = h.host.method("submit");
    assert_eq!(
        submits[0].get("args").and_then(|a| a.get("images")).cloned(),
        Some(Json::array(vec![reference.clone()]))
    );
    let creates = h.host.method("createConversation");
    assert_eq!(
        creates[0].get("args").and_then(|a| a.get("images")).cloned(),
        Some(Json::array(vec![reference]))
    );
}

#[test]
fn rename_conversation_needs_a_5_4_host() {
    let old = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(3.0))]);
    let mut h = Harness::new(old);
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::RenameConversation { id: 1, title: "renamed".to_string() });
    assert_eq!(
        h.ops.get(&2),
        Some(&Err("The host is too old for this (needs protocol 5.4); run `pinomad upgrade` on the host".to_string()))
    );
    assert!(h.host.method("renameConversation").is_empty());

    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::RenameConversation { id: 1, title: "renamed".to_string() });
    let call = &h.host.method("renameConversation")[0];
    assert_eq!(
        call.get("args").cloned(),
        Some(obj(&[("conversationId", Json::from(1.0)), ("title", Json::from("renamed"))]))
    );
}

#[test]
fn set_push_token_needs_a_5_7_host() {
    let old = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(6.0))]);
    let mut h = Harness::new(old);
    h.invoke(1, Call::SetPushToken { token: None });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.7")));
    assert!(h.host.method("setPushToken").is_empty());
}

#[test]
fn set_push_token_gates_the_apns_form_on_a_5_9_host() {
    // A 5.8 host: `null` deregisters fine, the object form is refused
    // client-side — it would be a 4400-malformed arg on the wire (ADR-0025).
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(8.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::SetPushToken { token: None });
    h.invoke(2, Call::SetPushToken {
        token: Some(ApnsPushToken { apns: "aa".repeat(32), environment: ApnsEnvironment::Production }),
    });
    assert!(matches!(h.ops.get(&1), Some(Ok(_))));
    assert!(matches!(h.ops.get(&2), Some(Err(e)) if e.contains("needs protocol 5.9")));
    let calls = h.host.method("setPushToken");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].get("args").cloned(), Some(obj(&[("token", Json::Null)])));
}

#[test]
fn set_push_token_sends_the_apns_registration_and_reports_errors() {
    let mut host = ScriptedHost::new(vec![obj(&[])], vec![]);
    host.call_errors.insert("setPushToken".to_string(), "Push tokens register over the secure channel only".to_string());
    let mut h = Harness::new(host);
    h.invoke(1, Call::SetPushToken {
        token: Some(ApnsPushToken { apns: "aa".repeat(32), environment: ApnsEnvironment::Development }),
    });
    let calls = h.host.method("setPushToken");
    assert_eq!(
        calls[0].get("args").cloned(),
        Some(obj(&[(
            "token",
            obj(&[("apns", Json::from("aa".repeat(32))), ("environment", Json::from("development"))]),
        )]))
    );
    // A failed call surfaces to the caller, never to the notice list.
    assert_eq!(h.ops.get(&1), Some(&Err("Push tokens register over the secure channel only".to_string())));
    assert!(h.notices().is_empty());
}

#[test]
fn fork_shows_in_the_side() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::Fork {
        entry_id: "9".to_string(),
        prompt: "continue here".to_string(),
        remove_tools: None,
        show: ForkShow::Side,
    });
    assert!(matches!(h.ops.get(&2), Some(Ok(_))));
    let fork_call = &h.host.method("fork")[0];
    let parent = fork_call.get("args").and_then(|a| a.get("conversationId")).and_then(Json::as_number).unwrap();
    let forked = parent + 1.0;
    assert_eq!(h.dig(&["side", "id"]), Some(Json::Number(forked)));
    assert_eq!(h.dig(&["conversation", "conversation", "id"]).and_then(|v| v.as_number()), Some(1.0));
    let submit = &h.host.method("submit")[0];
    assert_eq!(submit.get("args").and_then(|a| a.get("conversationId")).and_then(Json::as_number), Some(forked));
}

#[test]
fn side_streams_resubscribe_after_reconnect() {
    let mut h = setup();
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::ShowSide { id: Some(2) });
    let before = h.host.subscribes().len();
    h.disconnect(1000, None);
    h.fire_timer();
    let after: Vec<String> = h.host.subscribes()[before..].to_vec();
    assert!(after.contains(&"conversation:2".to_string()));
    assert!(after.contains(&format!("doc:{DOC_KIND}:2")));
    assert_eq!(
        h.dig(&["side", "conversation", "conversation", "id"]).and_then(|v| v.as_number()),
        Some(2.0)
    );
}

#[test]
fn archiving_the_sides_root_closes_it() {
    let mut host = ScriptedHost::new(vec![obj(&[])], vec![]);
    host.snapshots.insert(
        "conversations".to_string(),
        Json::array(vec![
            obj(&[("id", Json::from(1.0)), ("kind", Json::from("conversation"))]),
            obj(&[("id", Json::from(2.0)), ("kind", Json::from("fork")), ("parent", Json::from(1.0))]),
            obj(&[("id", Json::from(3.0)), ("kind", Json::from("conversation"))]),
        ]),
    );
    let mut h = Harness::new(host);
    h.invoke(1, Call::SwitchConversation { id: 3 });
    h.invoke(2, Call::ShowSide { id: Some(2) });
    h.invoke(3, Call::Archive { id: 3, archived: true });
    assert_eq!(h.dig(&["side", "id"]), Some(Json::from(2.0)));
    h.invoke(4, Call::Archive { id: 1, archived: true });
    assert!(h.view_get("side").is_none());
}

#[test]
fn switching_waits_for_a_fresh_snapshot_of_a_shared_stream() {
    let mut h = setup();
    h.invoke(1, Call::ShowSide { id: Some(2) });
    assert_eq!(h.dig(&["side", "id"]), Some(Json::from(2.0)));

    // Reconnect with conversation:2's snapshot held back: the stream stays
    // wanted but its value is stale until the host answers.
    h.host.held.insert("conversation:2".to_string());
    h.disconnect(1000, None);
    h.fire_timer();
    assert_eq!(h.connection(), "connected");

    h.invoke(2, Call::SwitchConversation { id: 2 });
    // The switch has not resolved — it waits for the fresh snapshot.
    assert!(h.ops.get(&2).is_none());

    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("conversation:2")),
        ("value", obj(&[
            ("conversation", obj(&[("id", Json::from(2.0)), ("marker", Json::from("new"))])),
            ("entries", Json::array(vec![])),
        ])),
    ]));
    assert!(matches!(h.ops.get(&2), Some(Ok(_))));
    let main = h.view_get("conversation").unwrap();
    assert_eq!(main.get("conversation").and_then(|c| c.get("marker")).cloned(), Some(Json::from("new")));
}

// ─── minor-version gating ─────────────────────────────────────────────

#[test]
fn a_5_0_host_never_sees_models_or_auth_subscriptions() {
    let hello_model = obj(&[("provider", Json::from("hp")), ("modelId", Json::from("h-1"))]);
    let host = ScriptedHost::new(
        vec![obj(&[])],
        vec![
            ("protocol".to_string(), protocol_obj(0.0)),
            ("models".to_string(), Json::array(vec![hello_model.clone()])),
        ],
    );
    let h = Harness::new(host);
    assert!(!h.host.subscribes().contains(&"models".to_string()));
    assert!(!h.host.subscribes().contains(&"auth".to_string()));
    assert_eq!(h.view_get("models"), Some(Json::array(vec![hello_model])));
    assert_eq!(h.view_get("auth"), Some(Json::Null));
}

#[test]
fn a_5_1_host_subscribes_to_models_and_auth() {
    let mut h = setup();
    assert!(h.host.subscribes().contains(&"models".to_string()));
    assert!(h.host.subscribes().contains(&"auth".to_string()));
    // hello.models is [] — the stream's snapshot must be what the view shows.
    assert_eq!(h.dig(&["models"]).and_then(|v| v.as_array().map(|a| a[0].get("modelId").cloned()).unwrap_or(None)), Some(Json::from("stream-1")));
    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("models")),
        ("value", Json::array(vec![obj(&[("provider", Json::from("p2")), ("modelId", Json::from("m-2"))])])),
    ]));
    assert_eq!(h.dig(&["models"]).and_then(|v| v.as_array().map(|a| a[0].get("provider").cloned()).unwrap_or(None)), Some(Json::from("p2")));
}

#[test]
fn logout_against_a_5_0_host_notices_and_sends_nothing() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(0.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::Logout { provider_id: "streamp".to_string() });
    assert!(h.host.method("logout").is_empty());
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy().contains("pinomad upgrade")).unwrap_or(false)
    }));
}

#[test]
fn a_5_1_host_never_sees_settings_and_its_defaults_come_from_the_hello() {
    let host = ScriptedHost::new(
        vec![obj(&[("model", obj(&[("provider", Json::from("hp")), ("modelId", Json::from("h-1"))]))])],
        vec![("protocol".to_string(), protocol_obj(1.0))],
    );
    let mut h = Harness::new(host);
    assert!(!h.host.subscribes().contains(&"settings".to_string()));
    assert_eq!(h.view_get("settings"), Some(Json::Null));
    assert_eq!(
        h.dig(&["defaults", "model", "modelId"]),
        Some(Json::from("h-1"))
    );
    h.invoke(1, Call::UpdateSettings { patch: obj(&[("defaultThinkingLevel", Json::from("high"))]) });
    assert!(h.host.method("updateSettings").is_empty());
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy().contains("needs protocol 5.2")).unwrap_or(false)
    }));
}

#[test]
fn list_folders_against_a_5_2_host_rejects() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(2.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::ListFolders { path: None });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.3")));
    h.invoke(2, Call::ListFolders { path: Some("/x".to_string()) });
    assert!(matches!(h.ops.get(&2), Some(Err(e)) if e.contains("pinomad upgrade")));
    assert!(h.host.method("listFolders").is_empty());
}

#[test]
fn accept_account_devices_needs_a_5_8_host() {
    let old = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(7.0))]);
    let mut h = Harness::new(old);
    h.invoke(1, Call::UpdateSettings { patch: obj(&[("acceptAccountDevices", Json::Bool(false))]) });
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy().contains("needs protocol 5.8")).unwrap_or(false)
    }));
    assert!(h.host.method("updateSettings").is_empty());
    // Keys the host knows still go through.
    h.invoke(2, Call::UpdateSettings { patch: obj(&[("steeringMode", Json::from("all"))]) });
    assert!(!h.host.method("updateSettings").is_empty());

    let mut h = setup();
    h.invoke(1, Call::UpdateSettings { patch: obj(&[("acceptAccountDevices", Json::Bool(false))]) });
    assert_eq!(
        h.host.method("updateSettings")[0].get("args").cloned(),
        Some(obj(&[("patch", obj(&[("acceptAccountDevices", Json::Bool(false))]))]))
    );
}

#[test]
fn host_name_needs_a_5_12_host() {
    // A pre-5.12 host would 4400 the unknown patch key — refuse locally, the
    // `null` reset included (ADR-0018 §2).
    let old = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(11.0))]);
    let mut h = Harness::new(old);
    h.invoke(1, Call::UpdateSettings { patch: obj(&[("hostName", Json::from("Desk"))]) });
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy().contains("needs protocol 5.12")).unwrap_or(false)
    }));
    assert!(h.host.method("updateSettings").is_empty());
    h.invoke(2, Call::UpdateSettings { patch: obj(&[("hostName", Json::Null)]) });
    assert!(h.host.method("updateSettings").is_empty());
    // Keys the host knows still go through on the same connection.
    h.invoke(3, Call::UpdateSettings { patch: obj(&[("steeringMode", Json::from("all"))]) });
    assert_eq!(h.host.method("updateSettings").len(), 1);

    let mut h = setup();
    h.invoke(1, Call::UpdateSettings { patch: obj(&[("hostName", Json::from("Desk"))]) });
    assert_eq!(
        h.host.method("updateSettings")[0].get("args").cloned(),
        Some(obj(&[("patch", obj(&[("hostName", Json::from("Desk"))]))]))
    );
}

#[test]
fn settings_stream_derives_defaults() {
    let host = ScriptedHost::new(
        vec![obj(&[("model", obj(&[("provider", Json::from("hp")), ("modelId", Json::from("h-1"))]))])],
        vec![],
    );
    let mut h = Harness::new(host);
    assert!(h.host.subscribes().contains(&"settings".to_string()));
    // The stream's values win over the hello's.
    assert_eq!(
        h.dig(&["defaults", "model", "modelId"]),
        Some(Json::from("stream-1"))
    );
    assert_eq!(
        h.dig(&["defaults", "thinkingLevel"]),
        Some(Json::from("high"))
    );
    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("settings")),
        ("value", obj(&[
            ("defaultModel", Json::Null),
            ("defaultThinkingLevel", Json::from("low")),
            ("custom", Json::array(vec![Json::from("defaultThinkingLevel")])),
        ])),
    ]));
    let defaults = h.view_get("defaults").unwrap();
    assert_eq!(defaults.get("thinkingLevel").cloned(), Some(Json::from("low")));
    assert!(defaults.get("model").is_none());
}

#[test]
fn agent_calls_need_a_5_6_host() {
    let role = obj(&[("name", Json::from("reviewer")), ("description", Json::from("Reviews code")), ("prompt", Json::from("Look for mistakes."))]);
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(5.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::CreateAgent { role: role.clone() });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.6")));
    h.invoke(2, Call::UpdateAgent { role });
    assert!(matches!(h.ops.get(&2), Some(Err(e)) if e.contains("pinomad upgrade")));
    h.invoke(3, Call::DeleteAgent { name: "reviewer".to_string() });
    assert!(matches!(h.ops.get(&3), Some(Err(e)) if e.contains("pinomad upgrade")));
    assert!(h.host.method("createAgent").is_empty());
    assert_eq!(h.view_get("agents"), Some(Json::Null));
    assert!(!h.host.subscribes().contains(&"agents".to_string()));
}

#[test]
fn create_conversation_with_agent_needs_a_5_10_host() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(9.0))]);
    let mut h = Harness::new(host);
    let make = |agent: Option<String>| Call::CreateConversation {
        home: obj(&[("kind", Json::from("chat"))]),
        text: "hi".to_string(),
        checkout: None,
        model: None,
        thinking_level: None,
        agent,
        images: vec![],
    };
    // Command-class: the op still "succeeds"; the reason lands as a notice —
    // and no frame goes out, since a 5.9 host would silently drop the field.
    h.invoke(1, make(Some("reviewer".to_string())));
    assert!(matches!(h.ops.get(&1), Some(Ok(_))));
    assert!(h.host.method("createConversation").is_empty());
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy().contains("needs protocol 5.10")).unwrap_or(false)
    }));
    // Without the field the same call goes through on the same connection.
    h.invoke(2, make(None));
    assert_eq!(h.host.method("createConversation").len(), 1);
    let args = &h.host.method("createConversation")[0];
    assert!(args.get("args").and_then(|a| a.get("agent")).is_none());
}

#[test]
fn create_conversation_carries_the_agent_on_5_10() {
    let mut h = setup();
    h.invoke(1, Call::CreateConversation {
        home: obj(&[("kind", Json::from("chat"))]),
        text: "hi".to_string(),
        checkout: None,
        model: None,
        thinking_level: None,
        agent: Some("reviewer".to_string()),
        images: vec![],
    });
    let call = &h.host.method("createConversation")[0];
    assert_eq!(
        call.get("args").and_then(|a| a.get("agent")).cloned(),
        Some(Json::from("reviewer"))
    );
}

#[test]
fn list_files_needs_a_5_10_host() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(9.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::ListFiles {
        scope: obj(&[("kind", Json::from("conversation")), ("conversationId", Json::from(7.0))]),
        query: "src".to_string(),
    });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.10")));
    assert!(h.host.method("listFiles").is_empty());
}

#[test]
fn list_files_is_not_queued_behind_a_hanging_command() {
    let mut h = setup();
    h.host.hung_methods.insert("archive".to_string());
    // The hung archive holds the command queue — a queued request must not
    // run, but listFiles (unqueued) is sent and answered immediately.
    h.invoke(1, Call::Archive { id: 1, archived: true });
    h.invoke(2, Call::RenameConversation { id: 1, title: "x".to_string() });
    h.invoke(3, Call::ListFiles {
        scope: obj(&[("kind", Json::from("conversation")), ("conversationId", Json::from(7.0))]),
        query: "src".to_string(),
    });
    assert_eq!(h.host.method("archive").len(), 1);
    assert!(h.host.method("renameConversation").is_empty());
    assert_eq!(h.host.method("listFiles").len(), 1);
    assert_eq!(
        h.host.method("listFiles")[0].get("args").cloned(),
        Some(obj(&[
            ("scope", obj(&[("kind", Json::from("conversation")), ("conversationId", Json::from(7.0))])),
            ("query", Json::from("src")),
        ]))
    );
    assert!(matches!(h.ops.get(&3), Some(Ok(_))));
    // The queue is still held by the hung archive: the rename never ran.
    assert!(h.ops.get(&2).is_none());
}

#[test]
fn image_needs_a_5_15_host() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(14.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::Image { ref_: "abc123".to_string() });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.15")));
    assert!(h.host.method("image").is_empty());
}

#[test]
fn image_is_direct_and_resolves_its_bytes() {
    let mut host = ScriptedHost::new(vec![obj(&[])], vec![]);
    host.call_results.insert(
        "image".to_string(),
        obj(&[
            ("data", Json::from("AA==")),
            ("mimeType", Json::from("image/png")),
        ]),
    );
    let mut h = Harness::new(host);
    h.host.hung_methods.insert("archive".to_string());
    h.invoke(1, Call::Archive { id: 1, archived: true });
    h.invoke(2, Call::RenameConversation { id: 1, title: "x".to_string() });
    h.invoke(3, Call::Image { ref_: "abc123".to_string() });
    assert_eq!(h.host.method("archive").len(), 1);
    // Same read-only, unqueued shape as listFiles: a hung command must not
    // block fetching an image the screen already needs.
    assert!(h.host.method("renameConversation").is_empty());
    assert_eq!(h.host.method("image").len(), 1);
    assert_eq!(
        h.host.method("image")[0].get("args").cloned(),
        Some(obj(&[("ref", Json::from("abc123"))])),
    );
    assert_eq!(
        h.ops.get(&3),
        Some(&Ok(Some(obj(&[
            ("data", Json::from("AA==")),
            ("mimeType", Json::from("image/png")),
        ])))),
    );
}

#[test]
fn list_skills_needs_a_5_13_host() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(12.0))]);
    let mut h = Harness::new(host);
    h.invoke(1, Call::ListSkills {
        scope: obj(&[("kind", Json::from("chat"))]),
    });
    assert!(matches!(h.ops.get(&1), Some(Err(e)) if e.contains("needs protocol 5.13")));
    assert!(h.host.method("listSkills").is_empty());
}

#[test]
fn list_skills_is_not_queued_behind_a_hanging_command() {
    // Same read-only, unqueued shape as listFiles (issue #143): the hung
    // archive holds the command queue — listSkills is still sent and resolves.
    let mut h = setup();
    h.host.hung_methods.insert("archive".to_string());
    h.invoke(1, Call::Archive { id: 1, archived: true });
    h.invoke(2, Call::RenameConversation { id: 1, title: "x".to_string() });
    h.invoke(3, Call::ListSkills {
        scope: obj(&[("kind", Json::from("project")), ("path", Json::from("/p")), ("checkout", Json::from("worktree"))]),
    });
    assert_eq!(h.host.method("archive").len(), 1);
    assert!(h.host.method("renameConversation").is_empty());
    assert_eq!(h.host.method("listSkills").len(), 1);
    assert_eq!(
        h.host.method("listSkills")[0].get("args").cloned(),
        Some(obj(&[(
            "scope",
            obj(&[("kind", Json::from("project")), ("path", Json::from("/p")), ("checkout", Json::from("worktree"))]),
        )]))
    );
    assert!(matches!(h.ops.get(&3), Some(Ok(_))));
    // The queue is still held by the hung archive: the rename never ran.
    assert!(h.ops.get(&2).is_none());
}

#[test]
fn queued_calls_return_host_outcomes_and_default_to_the_shown_conversation() {
    let mut host = ScriptedHost::new(vec![obj(&[])], vec![]);
    host.call_results.insert("withdrawQueued".to_string(), obj(&[("outcome", Json::from("withdrawn"))]));
    host.call_results.insert("steerQueued".to_string(), obj(&[("outcome", Json::from("unavailable"))]));
    let mut h = Harness::new(host);
    h.handle(Event::Invoke { op: 1, call: Call::SwitchConversation { id: 1 } });
    h.invoke(2, Call::WithdrawQueued { submission_id: 3, target: None });
    h.invoke(3, Call::SteerQueued { submission_id: 4, target: Some(2) });
    assert_eq!(
        h.ops.get(&2),
        Some(&Ok(Some(obj(&[("outcome", Json::from("withdrawn"))]))))
    );
    assert_eq!(
        h.ops.get(&3),
        Some(&Ok(Some(obj(&[("outcome", Json::from("unavailable"))]))))
    );
    assert_eq!(
        h.host.method("withdrawQueued")[0].get("args").cloned(),
        Some(obj(&[("conversationId", Json::from(1.0)), ("submissionId", Json::from(3.0))]))
    );
    assert_eq!(
        h.host.method("steerQueued")[0].get("args").cloned(),
        Some(obj(&[("conversationId", Json::from(2.0)), ("submissionId", Json::from(4.0))]))
    );
}

#[test]
fn withdraw_and_steer_need_a_5_14_host() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), protocol_obj(13.0))]);
    let mut h = Harness::new(host);
    h.handle(Event::Invoke { op: 1, call: Call::SwitchConversation { id: 1 } });
    h.invoke(2, Call::WithdrawQueued { submission_id: 3, target: None });
    h.invoke(3, Call::SteerQueued { submission_id: 3, target: None });
    assert!(matches!(h.ops.get(&2), Some(Err(e)) if e.contains("needs protocol 5.14")));
    assert!(matches!(h.ops.get(&3), Some(Err(e)) if e.contains("needs protocol 5.14")));
    assert!(h.host.method("withdrawQueued").is_empty());
    assert!(h.host.method("steerQueued").is_empty());
}

#[test]
fn a_5_6_host_subscribes_to_agents() {
    let mut h = setup();
    assert!(h.host.subscribes().contains(&"agents".to_string()));
    assert_eq!(h.view_get("agents"), Some(obj(&[("roles", Json::array(vec![])), ("problems", Json::array(vec![]))])));
    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("agents")),
        ("value", obj(&[
            ("roles", Json::array(vec![obj(&[("name", Json::from("reviewer"))])])),
            ("problems", Json::array(vec![])),
        ])),
    ]));
    assert_eq!(h.dig(&["agents", "roles"]).and_then(|v| v.as_array().map(|a| a.len())), Some(1));
}

#[test]
fn view_host_exposes_the_announced_identity() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("hostVersion".to_string(), Json::from("1.2.3"))]);
    let h = Harness::new(host);
    let host_view = h.view_get("host").unwrap();
    assert_eq!(host_view.get("version").cloned(), Some(Json::from("1.2.3")));
    assert_eq!(
        host_view.get("protocol").cloned(),
        Some(obj(&[("major", Json::from(PROTOCOL.major)), ("minor", Json::from(PROTOCOL.minor))]))
    );

    let h = setup();
    let host_view = h.view_get("host").unwrap();
    assert!(host_view.get("version").is_none());
}

// ─── connection semantics beyond the TS tests ─────────────────────────

#[test]
fn calls_made_while_disconnected_fail_immediately() {
    let mut h = setup();
    h.invoke(0, Call::SwitchConversation { id: 1 });
    assert!(matches!(h.ops.get(&0), Some(Ok(_))));
    h.disconnect(1000, None);
    assert_eq!(h.connection(), "reconnecting");
    h.invoke(1, Call::Submit {
        text: "offline".to_string(),
        when_busy: "followUp".to_string(),
        target: None,
        request_id: None,
        images: vec![],
    });
    // Commands report success (the error lands in the notice list), like the
    // reference's #command — but no call frame went out.
    assert!(matches!(h.ops.get(&1), Some(Ok(None))));
    assert!(h.host.method("submit").is_empty());
    assert!(h.notices().iter().any(|n| {
        n.get("message").and_then(Json::as_str).map(|m| m.to_string_lossy() == "Not connected to the host").unwrap_or(false)
    }));
}

#[test]
fn outstanding_calls_fail_on_disconnect_and_are_not_resent() {
    let mut host = ScriptedHost::new(vec![obj(&[])], vec![]);
    host.hang_calls = true;
    let mut h = Harness::new(host);
    // A request with a call in flight when the socket dies fails with
    // "Disconnected from host" — the reference's pending reject.
    h.invoke(1, Call::CreatePairing);
    assert_eq!(h.host.method("createPairing").len(), 1);
    h.disconnect(1000, None);
    assert_eq!(h.ops.get(&1), Some(&Err("Disconnected from host".to_string())));
    h.fire_timer();
    assert_eq!(h.connection(), "connected");
    // The call is not resent on the new connection.
    assert_eq!(h.host.method("createPairing").len(), 1);
}

#[test]
fn a_snapshot_wait_survives_disconnect_until_fresh() {
    // A waiting acquire is not a pending call — it waits for the NEW
    // connection's snapshot (stale values never served).
    let mut h = setup();
    h.host.held.insert("doc:pinomad.question:1".to_string());
    h.invoke(1, Call::SwitchConversation { id: 1 });
    assert!(h.ops.get(&1).is_none());
    h.disconnect(1000, None);
    assert!(h.ops.get(&1).is_none());
    h.host.held.clear();
    h.fire_timer();
    assert!(matches!(h.ops.get(&1), Some(Ok(_))));
    assert_eq!(
        h.dig(&["conversation", "conversation", "id"]).and_then(|v| v.as_number()),
        Some(1.0)
    );
}

#[test]
fn commands_execute_serially() {
    let mut h = setup();
    h.host.held.insert("conversation:1".to_string());
    h.invoke(1, Call::SwitchConversation { id: 1 });
    h.invoke(2, Call::SwitchConversation { id: 2 });
    assert!(h.host.subscribes().contains(&"conversation:1".to_string()));
    // The second switch must not run ahead of the still-waiting first.
    assert!(!h.host.subscribes().contains(&"conversation:2".to_string()));
    h.host.held.clear();
    h.deliver(obj(&[
        ("type", Json::from("snapshot")),
        ("stream", Json::from("conversation:1")),
        ("value", obj(&[("conversation", obj(&[("id", Json::from(1.0))])), ("entries", Json::array(vec![]))])),
    ]));
    assert!(matches!(h.ops.get(&1), Some(Ok(_))));
    assert!(h.host.subscribes().contains(&"conversation:2".to_string()));
    assert!(matches!(h.ops.get(&2), Some(Ok(_))));
}

#[test]
fn protocol_mismatch_before_ready_reports_it() {
    let host = ScriptedHost::new(vec![obj(&[])], vec![("protocol".to_string(), obj(&[("major", Json::from(6.0))]))]);
    let mut remote = RemoteDurable::new(RemoteDurableOptions {
        transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
        reconnect_delay_ms: None,
        request_id: None,
    });
    // Drive manually: open → socket opened → hello data → commands.
    let mut commands = remote.handle(Event::SocketOpened { conn: 1 });
    commands.extend(remote.handle(Event::SocketData { conn: 1, bytes: host.hello().into_bytes() }));
    let ready = commands.iter().find_map(|c| match c {
        Command::Ready { outcome } => Some(outcome.clone()),
        _ => None,
    });
    assert_eq!(
        ready,
        Some(ReadyOutcome::Mismatch {
            host_major: 6.0,
            client_major: 5.0,
            direction: "client-older".to_string(),
            host_version: None,
        })
    );
    // The socket closes and nothing reconnects.
    assert!(commands.iter().any(|c| matches!(c, Command::CloseSocket { conn: 1 })));
}

#[test]
fn first_view_waits_for_every_host_stream() {
    let mut host = ScriptedHost::new(vec![obj(&[])], vec![]);
    host.held.insert("settings".to_string());
    let mut remote = RemoteDurable::new(RemoteDurableOptions {
        transport: Box::new(PlaintextTransport { url: "ws://fake/".to_string() }),
        reconnect_delay_ms: None,
        request_id: None,
    });
    // open → SocketOpened → hello arrives → subscribes go out; every stream
    // but `settings` gets its snapshot. No Ready yet.
    let mut queue: VecDeque<Command> = remote.handle(Event::SocketOpened { conn: 1 }).into();
    let hello = host.hello();
    queue.extend(remote.handle(Event::SocketData { conn: 1, bytes: hello.into_bytes() }));
    let mut ready: Option<ReadyOutcome> = None;
    while let Some(command) = queue.pop_front() {
        if let Command::SendBytes { conn, bytes } = command {
            for reply in host.receive(std::str::from_utf8(&bytes).unwrap()) {
                let more = remote.handle(Event::SocketData { conn, bytes: reply.into_bytes() });
                for command in more {
                    if let Command::Ready { outcome } = command {
                        ready = Some(outcome);
                    } else {
                        queue.push_back(command);
                    }
                }
            }
        } else if let Command::Ready { outcome } = command {
            ready = Some(outcome);
        }
    }
    assert!(ready.is_none());
}

// A test-only transport import assertion: remote_durable takes any
// Transport; PlaintextTransport doubles as the scripted plaintext lane.
#[allow(dead_code)]
fn _assert_transport_is_dyn(t: Box<dyn Transport>) -> Box<dyn Transport> {
    t
}
