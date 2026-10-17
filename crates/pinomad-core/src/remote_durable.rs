// RemoteDurable as a pure state machine (ADR-0024 §3): events in, commands
// out, no I/O and no clock inside. The platform layer runs the socket and
// the reconnect timer; the core decides everything remote-durable.ts's
// RemoteClient decides — connection lifecycle, stream subscriptions, the
// serialized command queue, and the derived view.
//
// Event→command mapping mirrors the reference frame by frame:
// - calls while not "connected" fail with "Not connected to the host";
// - a lost socket fails every sent call awaiting a result (never resent);
// - after a reconnect a stream is stale until its new snapshot lands, so an
//   acquire waits even for streams already wanted;
// - close 4400/4401 stop reconnecting; 1008 and ordinary failures retry
//   with the same backoff as the reference.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use crate::delta::{apply_immutable, op_from_json};
use crate::frames::{
    classify_server_frame, conversation_stream, doc_stream, encode_client_frame, host_streams,
    host_supports_call, host_supports_feature, minor_version, ApnsPushToken, ClientFrame, HostFeature,
    ServerFrame, INVALID_FRAME_CLOSE_CODE, PROTOCOL, UNAUTHORIZED_CLOSE_CODE,
};
use crate::json::{Json, JsonObject};
use crate::organization::{checkout_of, home_of, organize};
use crate::transport::{ConnOut, Connection, Transport};
use crate::u16str::U16String;

const DEFAULT_RECONNECT_MIN_MS: u64 = 200;
const DEFAULT_RECONNECT_MAX_MS: u64 = 2000;
const CONNECTED: &str = "connected";
const RECONNECTING: &str = "reconnecting";
const CLOSED: &str = "closed";
const OUTDATED: &str = "outdated";

/// The FFI-facing call surface — every DurableController method, modeled as
/// data so the platform layer can construct them.
#[derive(Clone, Debug)]
pub enum Call {
    AddProject { path: String },
    ListFolders { path: Option<String> },
    RemoveProject { path: String },
    RenameConversation { id: u64, title: String },
    CreateConversation {
        home: Json,
        text: String,
        checkout: Option<Json>,
        model: Option<Json>,
        thinking_level: Option<String>,
        images: Vec<Json>,
    },
    Archive { id: u64, archived: bool },
    Submit {
        text: String,
        when_busy: String,
        target: Option<u64>,
        request_id: Option<String>,
        images: Vec<Json>,
    },
    Compact { instructions: Option<String> },
    /// Not queued behind the command chain — it resolves once the
    /// conversation is idle, same as the reference.
    Abort { target: Option<u64> },
    SetThinkingLevel { level: String },
    SetModel { model: Json },
    ToggleTasks,
    SwitchConversation { id: u64 },
    ShowSide { id: Option<u64> },
    Fork {
        entry_id: String,
        prompt: String,
        remove_tools: Option<Vec<String>>,
        show: ForkShow,
    },
    Answer { kind: String, request_id: String, answers: Json, target: Option<u64> },
    Changes,
    CreatePairing,
    RevokeDevice { public_key: String },
    Logout { provider_id: String },
    UpdateSettings { patch: Json },
    CreateAgent { role: Json },
    UpdateAgent { role: Json },
    DeleteAgent { name: String },
    /// `setPushToken` — register (`Some`) or deregister (`None`) this
    /// device's APNs token. The API only exposes the APNs object form:
    /// the legacy Expo string still parses on the host but is refused,
    /// and the platform layer never sends it (ADR-0025 §7).
    SetPushToken { token: Option<ApnsPushToken> },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ForkShow {
    Main,
    Side,
}

/// Everything the platform layer feeds in. `conn` ids come from
/// `OpenConnection` commands; `op` ids are the caller's.
#[derive(Debug)]
pub enum Event {
    SocketOpened { conn: u32 },
    SocketData { conn: u32, bytes: Vec<u8> },
    SocketClosed { conn: u32, code: u16, reason: Option<String> },
    /// The platform could not write what it was asked to — the socket is
    /// dead for practical purposes.
    SendFailed { conn: u32 },
    TimerFired { timer: u32 },
    Invoke { op: u64, call: Call },
    Close,
    /// App returned to the foreground (ADR-0024 §3): a pending reconnect
    /// backoff is cut short — the timer is canceled and a new connection
    /// generation opens immediately.
    Foreground,
    /// App went to the background: accepted, a no-op. The connection stays
    /// as it is; the platform decides when to suspend the socket itself.
    Background,
    /// Connectivity changed (ADR-0024 §3): same as Foreground — a pending
    /// reconnect backoff is skipped and the retry fires now.
    NetworkChanged,
}

/// Everything the platform layer executes — open/write/close a socket,
/// arm a timer, persist a completed pairing, surface readiness, observe the
/// view, and resolve operations by their caller's id.
#[derive(Debug)]
pub enum Command {
    OpenConnection { conn: u32, url: String },
    SendBytes { conn: u32, bytes: Vec<u8> },
    CloseSocket { conn: u32 },
    /// Arm the reconnect timer; `timer` is echoed back via TimerFired.
    ScheduleReconnect { timer: u32, delay_ms: u64 },
    /// Drop a previously armed reconnect timer — an early reconnect or a
    /// closed session makes it dead. Platforms holding real timers (iOS
    /// suspends them in the background) must not wake for it.
    CancelReconnect { timer: u32 },
    Ready { outcome: ReadyOutcome },
    /// `view()` changed; read it again. Emitted at most once per handle().
    ViewChanged,
    /// First channel with a pairing secret authenticated: what the app
    /// persists — where, which host, which device key.
    Paired { url: String, host_key: String, private_key: String },
    OperationSucceeded { op: u64, value: Option<Json> },
    OperationFailed { op: u64, error: String },
}

/// What `RemoteDurable` reports when the first view arrives — or why it
/// will never arrive, mapped to the ready promise's rejections.
#[derive(Clone, Debug, PartialEq)]
pub enum ReadyOutcome {
    Connected,
    /// Socket closed with 4401 before the first view.
    Unauthorized,
    /// Host announced a protocol major we do not speak.
    Mismatch { host_major: f64, client_major: f64, direction: String, host_version: Option<String> },
    Error(String),
}

pub struct RemoteDurableOptions {
    pub transport: Box<dyn Transport>,
    /// `reconnectDelayMs` — {min,max} backoff seed.
    pub reconnect_delay_ms: Option<(u64, u64)>,
    /// `newRequestId` — a fresh 32-hex-char id per submit/fork; injected so
    /// tests can be deterministic and FFI hosts can supply their own RNG.
    pub request_id: Option<Box<dyn FnMut() -> String + Send>>,
}

#[derive(Clone, Copy, PartialEq)]
enum OpKind {
    /// Serialized; failure becomes a notice and the op still succeeds.
    Command,
    /// Serialized; the caller owns result and error.
    Request,
    /// `abort` — not part of the serialized chain; failure becomes a notice
    /// and the op still reports success (the promise resolves).
    Unqueued,
}

/// One in-flight controller operation.
struct ActiveOp {
    op_id: u64,
    kind: OpKind,
    /// Whether this op blocks the serialized queue (commands and requests).
    holds_queue: bool,
    steps: VecDeque<Step>,
    waiting: Option<Wait>,
    /// The last call result (for follow-on steps like fork's submit).
    last_result: Option<Json>,
}

enum Wait {
    /// A call frame is out; pending_calls maps its id back to this op.
    Call,
    /// Streams this op must see a snapshot for before continuing.
    Snapshots(BTreeSet<Vec<u16>>),
}

enum Step {
    Call { method: &'static str, args: Json },
    /// fork's submit — its conversationId comes from the last call result.
    CallForkSubmit { prompt: String },
    /// switchConversation / showSide — id check, acquire, then ApplyShow.
    Show { target: ShowTarget, slot: Slot },
    /// Internal: `Show`'s second half after the acquire resolves.
    ApplyShow { slot: Slot, id: u64 },
    /// archive's cleanup: drop the main slot when it was the archived one.
    UnshowCurrentIf { id: u64, archived: bool },
    /// archive's cleanup: drop the side slot when it descends from the id.
    UnsideIfArchived { id: u64, archived: bool },
    /// showSide(undefined), reachable as its own step for Call::ShowSide.
    Unside,
    ToggleTasks,
    Done { value: DoneValue },
}

#[derive(Clone, Copy)]
enum ShowTarget {
    Id(u64),
    /// fork's `{conversationId}` from the last call result.
    FromResult,
}

#[derive(Clone, Copy, PartialEq)]
enum Slot {
    Main,
    Side,
}

enum DoneValue {
    Unit,
    LastResult,
}

struct DocDecl {
    kind: Json,
    presentation: Option<Json>,
}

struct Conn {
    id: u32,
    inner: Box<dyn Connection>,
}

struct FirstView {
    /// Host streams whose snapshots the first view waits for.
    remaining: HashSet<Vec<u16>>,
    hello: Json,
}

fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}

pub struct RemoteDurable {
    transport: Box<dyn Transport>,
    conn: Option<Conn>,
    next_conn: u32,
    wanted: BTreeSet<Vec<u16>>,
    values: HashMap<Vec<u16>, Json>,
    fresh: HashSet<Vec<u16>>,
    docs: Vec<DocDecl>,
    pending_calls: HashMap<u64, u64>,
    next_call: u64,
    next_notice: u64,
    state: Option<JsonObject>,
    current: Option<u64>,
    side: Option<u64>,
    host_minor: u32,
    hello_models: Json,
    hello_defaults: Json,
    host_version: Option<Json>,
    attempt: u32,
    closed: bool,
    reconnect_min_ms: u64,
    reconnect_max_ms: u64,
    reconnect_timer: Option<u32>,
    next_timer: u32,
    queue: VecDeque<(u64, OpKind, Call)>,
    active: Vec<ActiveOp>,
    first_view: Option<FirstView>,
    ready_sent: bool,
    view_dirty: bool,
    request_id: Box<dyn FnMut() -> String + Send>,
    /// The delivery version (ADR-0024 §5): bumped once per emitted
    /// `ViewChanged`, so a snapshot read later reports exactly which view
    /// change it answers.
    version: u64,
    out: Vec<Command>,
}

impl RemoteDurable {
    pub fn new(options: RemoteDurableOptions) -> Self {
        let (reconnect_min_ms, reconnect_max_ms) =
            options.reconnect_delay_ms.unwrap_or((DEFAULT_RECONNECT_MIN_MS, DEFAULT_RECONNECT_MAX_MS));
        let request_id = options.request_id.unwrap_or_else(|| Box::new(default_request_id));
        let mut this = RemoteDurable {
            transport: options.transport,
            conn: None,
            next_conn: 0,
            wanted: BTreeSet::new(),
            values: HashMap::new(),
            fresh: HashSet::new(),
            docs: Vec::new(),
            pending_calls: HashMap::new(),
            next_call: 1,
            next_notice: 1,
            state: None,
            current: None,
            side: None,
            host_minor: 0,
            hello_models: Json::Null,
            hello_defaults: Json::Object(Arc::new(JsonObject::new())),
            host_version: None,
            attempt: 0,
            closed: false,
            reconnect_min_ms,
            reconnect_max_ms,
            reconnect_timer: None,
            next_timer: 1,
            queue: VecDeque::new(),
            active: Vec::new(),
            first_view: None,
            ready_sent: false,
            view_dirty: false,
            request_id,
            version: 0,
            out: Vec::new(),
        };
        this.open();
        this
    }

    /// Commands queued outside handle() — the constructor's first
    /// OpenConnection waits here for the platform to pick up.
    pub fn take(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.out)
    }

    /// The current view — absent until Ready(Connected).
    pub fn view(&self) -> Option<Json> {
        self.state.as_ref().map(|state| Json::Object(Arc::new(state.clone())))
    }

    /// The serialized view — `JSON.stringify` of `view()`.
    pub fn view_json(&self) -> Option<String> {
        self.view().map(|view| view.to_json())
    }

    /// How many `ViewChanged` commands this session has emitted — the
    /// version a delivered snapshot is tagged with.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn handle(&mut self, event: Event) -> Vec<Command> {
        self.view_dirty = false;
        match event {
            Event::SocketOpened { conn } => {
                if self.live_conn(conn) {
                    let mut conn_out = Vec::new();
                    self.conn.as_mut().unwrap().inner.opened(&mut conn_out);
                    self.drain_conn_out(conn_out);
                }
            }
            Event::SocketData { conn, bytes } => {
                if self.live_conn(conn) {
                    let mut conn_out = Vec::new();
                    self.conn.as_mut().unwrap().inner.data(&bytes, &mut conn_out);
                    self.drain_conn_out(conn_out);
                }
            }
            Event::SocketClosed { conn, code, reason } => {
                if self.live_conn(conn) {
                    let mut conn_out = Vec::new();
                    self.conn.as_mut().unwrap().inner.closed(code, reason.clone(), &mut conn_out);
                    self.drain_conn_out(conn_out);
                }
            }
            Event::SendFailed { conn } => {
                if self.live_conn(conn) {
                    // A write failure means the socket is broken — tell the
                    // platform to close it, then treat it as an abnormal
                    // close so pending calls fail and the retry arms.
                    self.out.push(Command::CloseSocket { conn });
                    self.lost(1006, None);
                }
            }
            Event::TimerFired { timer } => {
                if self.reconnect_timer == Some(timer) && !self.closed {
                    self.reconnect_timer = None;
                    self.open();
                }
            }
            Event::Invoke { op, call } => self.invoke(op, call),
            Event::Close => self.close(),
            Event::Foreground | Event::NetworkChanged => self.reconnect_now(),
            Event::Background => {}
        }
        if self.view_dirty {
            self.version += 1;
            self.out.push(Command::ViewChanged);
        }
        std::mem::take(&mut self.out)
    }

    /// ADR-0024 §3's native addition — the TS reference has no counterpart
    /// (the browser never sleeps its timers): iOS suspends timers in the
    /// background, so a pending reconnect backoff could stall long after
    /// the app is usable again. While waiting, cancel the timer, reset the
    /// backoff, and connect now. Connected, connecting, and terminal
    /// states are untouched.
    fn reconnect_now(&mut self) {
        if let Some(timer) = self.reconnect_timer.take() {
            self.attempt = 0;
            self.out.push(Command::CancelReconnect { timer });
            self.open();
        }
    }

    fn live_conn(&self, conn: u32) -> bool {
        self.conn.as_ref().map(|c| c.id) == Some(conn)
    }

    /// `#open` — a new connection generation.
    fn open(&mut self) {
        self.next_conn += 1;
        let id = self.next_conn;
        let inner = self.transport.open();
        self.conn = Some(Conn { id, inner });
        self.out.push(Command::OpenConnection { conn: id, url: self.transport.url().to_string() });
    }

    /// Translate one connection's outcomes into commands and state changes.
    /// The conn's id is captured once — after `lost` it is dead and any
    /// leftover outcomes drop.
    fn drain_conn_out(&mut self, outcomes: Vec<ConnOut>) {
        for outcome in outcomes {
            let Some(id) = self.conn.as_ref().map(|conn| conn.id) else {
                return;
            };
            match outcome {
                ConnOut::SendBytes(bytes) => self.out.push(Command::SendBytes { conn: id, bytes }),
                ConnOut::Close => self.out.push(Command::CloseSocket { conn: id }),
                ConnOut::Text(text) => self.receive_text(&text),
                ConnOut::Closed { code, reason } => self.lost(code, reason),
                ConnOut::Paired => self.paired(),
            }
        }
    }

    fn paired(&mut self) {
        if let Some(details) = self.transport.mark_paired() {
            self.out.push(Command::Paired {
                url: details.0,
                host_key: details.1,
                private_key: details.2,
            });
        }
    }

    /// `#send` — a text frame through the live connection (queues inside a
    /// secure connection that is still handshaking, like the reference).
    fn send(&mut self, frame: ClientFrame) {
        let text = encode_client_frame(&frame);
        if let Some(conn) = self.conn.as_mut() {
            let mut conn_out = Vec::new();
            conn.inner.send(text, &mut conn_out);
            self.drain_conn_out(conn_out);
        }
    }

    /// `#receive` — one complete JSON text frame; errors are channel
    /// failures like a JSON.parse/apply exception inside the transport.
    fn receive_text(&mut self, text: &str) {
        let parsed = match Json::parse(text) {
            Ok(parsed) => parsed,
            Err(error) => return self.fail_channel(&format!("invalid frame JSON: {error}")),
        };
        let frame = classify_server_frame(parsed);
        let result = match frame {
            ServerFrame::Hello(value) => self.receive_hello(value),
            ServerFrame::Snapshot { stream, value } => self.receive_snapshot(stream, value),
            ServerFrame::Ops { stream, ops } => self.receive_ops(stream, ops),
            ServerFrame::Ended { stream, reason } => self.receive_ended(stream, reason),
            ServerFrame::Result { id, ok, value, error } => {
                self.receive_result(id, ok, value, error);
                Ok(())
            }
            ServerFrame::Notice { level, message } => {
                self.notice(level, message);
                Ok(())
            }
            ServerFrame::Ignored => Ok(()),
        };
        if let Err(error) = result {
            self.fail_channel(&error);
        }
    }

    /// The secure transport's fail(): close the socket and surface a 1008 —
    /// the same code a real malformed record produces.
    fn fail_channel(&mut self, message: &str) {
        if let Some(conn) = self.conn.take() {
            self.out.push(Command::CloseSocket { conn: conn.id });
        }
        self.lost(1008, Some(format!("Secure channel failed: {message}")));
    }

    fn stream_of(value: &Json) -> Option<Vec<u16>> {
        value.as_str().map(|s| s.0.clone())
    }

    fn receive_hello(&mut self, frame: Json) -> Result<(), String> {
        let announced = frame.get("protocol").cloned().unwrap_or(Json::Null);
        let raw_major = match &announced {
            Json::Number(_) => Some(announced.clone()),
            Json::Object(object) => object.get(&key("major")).cloned(),
            _ => None,
        };
        // `hostMajor !== PROTOCOL.major` — a non-number major mismatches.
        if !matches!(raw_major, Some(Json::Number(v)) if v == PROTOCOL.major as f64) {
            let host_major = raw_major.and_then(|v| v.as_number()).unwrap_or(f64::NAN);
            let host_version = frame
                .get("hostVersion")
                .and_then(Json::as_str)
                .map(|s| s.to_string_lossy());
            let direction = if host_major > PROTOCOL.major as f64 { "client-older" } else { "host-older" };
            self.closed = true;
            if self.state.is_none() {
                self.ready_sent = true;
                self.out.push(Command::Ready {
                    outcome: ReadyOutcome::Mismatch {
                        host_major,
                        client_major: PROTOCOL.major as f64,
                        direction: direction.to_string(),
                        host_version,
                    },
                });
            } else {
                let mut mismatch = JsonObject::new();
                set(&mut mismatch, "hostMajor", Json::Number(host_major));
                set(&mut mismatch, "clientMajor", Json::Number(PROTOCOL.major as f64));
                if let Some(version) = frame.get("hostVersion") {
                    set(&mut mismatch, "hostVersion", version.clone());
                }
                set(&mut mismatch, "direction", Json::from(direction));
                self.set_field("connection", Json::from(OUTDATED));
                self.set_field("protocolMismatch", Json::Object(Arc::new(mismatch)));
                let message = if direction == "client-older" {
                    format!(
                        "Client out of date: the host speaks protocol major {}, this client speaks {}",
                        js_number(host_major),
                        js_number(PROTOCOL.major as f64)
                    )
                } else {
                    format!(
                        "Host out of date: this client speaks protocol major {}, the host speaks {}",
                        js_number(PROTOCOL.major as f64),
                        js_number(host_major)
                    )
                };
                self.notice(Json::from("error"), Json::from(message));
            }
            // The close below stays terminal — closed is already set.
            self.send_close();
            return Ok(());
        }
        let host_minor = match &announced {
            Json::Object(object) => minor_version(object.get(&key("minor")))?,
            // A number-typed `protocol` (the legacy form) declares no minor.
            _ => 0,
        };
        self.host_minor = host_minor;
        self.attempt = 0;
        self.docs = parse_docs(&frame)?;
        self.hello_models = frame.get("models").cloned().unwrap_or(Json::Null);
        self.hello_defaults = frame
            .get("defaults")
            .filter(|v| !matches!(v, Json::Null))
            .cloned()
            .unwrap_or_else(|| Json::Object(Arc::new(JsonObject::new())));
        self.host_version = frame.get("hostVersion").cloned();
        self.fresh.clear();
        // A host that got older between reconnects no longer covers every
        // host stream; drop those and their values (ADR-0018 §1).
        let covered: HashSet<&'static str> = host_streams(host_minor).into_iter().collect();
        for name in crate::frames::host_stream_names() {
            let units = key(name);
            if covered.contains(name) {
                self.wanted.insert(units);
            } else {
                self.wanted.remove(&units);
                self.values.remove(&units);
                self.fresh.remove(&units);
            }
        }
        if let Some(id) = self.current {
            for stream in self.conversation_streams(id) {
                self.wanted.insert(stream);
            }
        }
        if let Some(id) = self.side {
            for stream in self.conversation_streams(id) {
                self.wanted.insert(stream);
            }
        }
        for stream in self.wanted.clone() {
            self.send(ClientFrame::Subscribe { stream: U16String(stream) });
        }
        if self.state.is_some() {
            self.set_or_clear("session", frame.get("session").cloned());
            self.set_or_clear("toolPresentations", frame.get("toolPresentations").cloned());
            self.set_field("connection", Json::from(CONNECTED));
            self.set_field("host", self.host_info());
            self.refresh()?;
        } else {
            // First view waits for every covered host stream's snapshot.
            let remaining: HashSet<Vec<u16>> =
                host_streams(host_minor).into_iter().map(|name| key(name)).collect();
            self.first_view = Some(FirstView { remaining, hello: frame });
        }
        Ok(())
    }

    fn receive_snapshot(&mut self, stream: Json, value: Json) -> Result<(), String> {
        let Some(units) = Self::stream_of(&stream) else {
            return Ok(());
        };
        if !self.wanted.contains(&units) {
            return Ok(());
        }
        self.values.insert(units.clone(), value);
        self.fresh.insert(units.clone());
        self.refresh()?;
        // Waiters resolve after the refresh — matching the reference's
        // ordering (snapshot sets values, then resolves the waiters).
        let mut ready_ops: Vec<u64> = Vec::new();
        let mut first_ready = false;
        if let Some(first) = &mut self.first_view {
            if first.remaining.remove(&units) && first.remaining.is_empty() {
                first_ready = true;
            }
        }
        for op in self.active.iter_mut() {
            if let Some(Wait::Snapshots(waiting)) = &mut op.waiting {
                if waiting.remove(&units) && waiting.is_empty() {
                    op.waiting = None;
                    ready_ops.push(op.op_id);
                }
            }
        }
        if first_ready {
            self.finish_first_view();
        }
        for op_id in ready_ops {
            if let Some(index) = self.active.iter().position(|op| op.op_id == op_id) {
                self.drive(index);
            }
        }
        Ok(())
    }

    fn receive_ops(&mut self, stream: Json, ops: Json) -> Result<(), String> {
        let Some(units) = Self::stream_of(&stream) else {
            return Ok(());
        };
        if !self.wanted.contains(&units) || !self.values.contains_key(&units) {
            return Ok(());
        }
        let raw = ops.as_array().ok_or_else(|| "ops frame is not an array".to_string())?;
        let decoded: Vec<_> = raw
            .iter()
            .map(op_from_json)
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        let before = self.values.get(&units).expect("checked above");
        let after = apply_immutable(before, &decoded).map_err(|error| error.to_string())?;
        self.values.insert(units, after);
        self.refresh()
    }

    fn receive_ended(&mut self, stream: Json, reason: Json) -> Result<(), String> {
        let Some(units) = Self::stream_of(&stream) else {
            return Ok(());
        };
        self.wanted.remove(&units);
        self.values.remove(&units);
        self.fresh.remove(&units);
        let reason_text = U16String::js_string(&reason).to_string_lossy();
        let stream_text = U16String(units.clone()).to_string_lossy();
        // Snapshot waiters on an ended stream reject, like the reference.
        let failed: Vec<u64> = self
            .active
            .iter()
            .filter_map(|op| match &op.waiting {
                Some(Wait::Snapshots(waiting)) if waiting.contains(&units) => Some(op.op_id),
                _ => None,
            })
            .collect();
        for op_id in failed {
            if let Some(index) = self.active.iter().position(|op| op.op_id == op_id) {
                self.fail_op(index, &format!("Stream {stream_text} ended: {reason_text}"));
            }
        }
        // A first-view wait on an ended stream never completes — the
        // reference's Promise.all just never resolves.
        if let Some(first) = &self.first_view {
            if first.remaining.contains(&units) {
                self.first_view = None;
            }
        }
        self.refresh()
    }

    fn receive_result(&mut self, id: Json, ok: Json, value: Json, error: Json) {
        // Map.get(frame.id) is strict: a non-integer or non-numeric id can
        // never match a pending call.
        let Some(call_id) = id.as_number().filter(|v| v.fract() == 0.0 && *v >= 0.0).map(|v| v as u64)
        else {
            return;
        };
        let Some(op_id) = self.pending_calls.remove(&call_id) else {
            return;
        };
        let Some(index) = self.active.iter().position(|op| op.op_id == op_id) else {
            return;
        };
        if ok.truthy() {
            self.active[index].waiting = None;
            self.active[index].last_result = Some(value);
            self.drive(index);
        } else {
            let message = U16String::js_string(&error).to_string_lossy();
            self.fail_op(index, &message);
        }
    }

    // ─── Lost/close/reconnect ───────────────────────────────────────────

    /// `#lost` — the socket died. Pending calls fail "Disconnected from
    /// host"; what happens next follows the close-code policy.
    fn lost(&mut self, code: u16, reason: Option<String>) {
        self.conn = None;
        let pending: Vec<u64> = self.pending_calls.drain().map(|(_, op)| op).collect();
        for op_id in pending {
            if let Some(index) = self.active.iter().position(|op| op.op_id == op_id) {
                self.fail_op(index, "Disconnected from host");
            }
        }
        if self.state.is_none() {
            self.closed = true;
            if !self.ready_sent {
                self.ready_sent = true;
                self.out.push(Command::Ready {
                    outcome: if code == UNAUTHORIZED_CLOSE_CODE {
                        ReadyOutcome::Unauthorized
                    } else {
                        ReadyOutcome::Error(
                            reason.unwrap_or_else(|| format!("Could not connect to {}", self.transport.url())),
                        )
                    },
                });
            }
            return;
        }
        if self.closed {
            return;
        }
        if code == UNAUTHORIZED_CLOSE_CODE {
            self.closed = true;
            self.set_field("connection", Json::from(CLOSED));
            self.set_field("unauthorized", Json::Bool(true));
            self.notice(
                Json::from("error"),
                Json::from("Unauthorized: this client is not allowed (wrong token, or the device is not paired or was revoked)"),
            );
            return;
        }
        // 4400 is terminal like 4401 (ADR-0018 §4): the host rejected a
        // malformed frame, and a reconnect would send the same ones. A
        // plain 1008 (a failed secure handshake, say) still reconnects.
        if code == INVALID_FRAME_CLOSE_CODE {
            self.closed = true;
            self.set_field("connection", Json::from(CLOSED));
            let suffix = reason.map(|r| format!(": {r}")).unwrap_or_default();
            self.notice(
                Json::from("error"),
                Json::from(format!("The host rejected a malformed frame from this client{suffix}")),
            );
            return;
        }
        self.set_field("connection", Json::from(RECONNECTING));
        let delay = self.reconnect_min_ms.saturating_mul(2u64.saturating_pow(self.attempt)).min(self.reconnect_max_ms);
        self.attempt += 1;
        let timer = self.next_timer;
        self.next_timer += 1;
        self.reconnect_timer = Some(timer);
        self.out.push(Command::ScheduleReconnect { timer, delay_ms: delay });
    }

    /// `#close` — the app ended the session.
    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        // A session that ends while backing off leaves no timer behind.
        if let Some(timer) = self.reconnect_timer.take() {
            self.out.push(Command::CancelReconnect { timer });
        }
        self.set_field("connection", Json::from(CLOSED));
        self.send_close();
    }

    fn send_close(&mut self) {
        if let Some(conn) = self.conn.as_mut() {
            let mut conn_out = Vec::new();
            conn.inner.close(&mut conn_out);
            self.drain_conn_out(conn_out);
        }
    }

    // ─── Controller surface ─────────────────────────────────────────────

    fn invoke(&mut self, op: u64, call: Call) {
        let kind = match &call {
            Call::AddProject { .. }
            | Call::ListFolders { .. }
            | Call::RenameConversation { .. }
            | Call::Changes
            | Call::CreatePairing
            | Call::CreateAgent { .. }
            | Call::UpdateAgent { .. }
            | Call::DeleteAgent { .. }
            | Call::SetPushToken { .. } => OpKind::Request,
            Call::Abort { .. } => OpKind::Unqueued,
            _ => OpKind::Command,
        };
        match kind {
            OpKind::Unqueued => self.begin_op(op, kind, call, false),
            _ => {
                self.queue.push_back((op, kind, call));
                self.pump();
            }
        }
    }

    fn pump(&mut self) {
        if self.active.iter().any(|op| op.holds_queue) {
            return;
        }
        if let Some((op_id, kind, call)) = self.queue.pop_front() {
            self.begin_op(op_id, kind, call, true);
        }
    }

    fn begin_op(&mut self, op_id: u64, kind: OpKind, call: Call, holds_queue: bool) {
        match self.op_steps(&call) {
            Ok(steps) => {
                self.active.push(ActiveOp {
                    op_id,
                    kind,
                    holds_queue,
                    steps,
                    waiting: None,
                    last_result: None,
                });
                let index = self.active.len() - 1;
                self.drive(index);
            }
            Err(error) => self.finish_failed(op_id, kind, &error),
        }
    }

    /// Build the op's step list the moment it starts executing — gates and
    /// `conversationId()` evaluate then, not at invoke time (the reference's
    /// closures capture the client and read it when they run).
    fn op_steps(&mut self, call: &Call) -> Result<VecDeque<Step>, String> {
        let too_old = |needs: &str| {
            format!("The host is too old for this (needs protocol {needs}); run `pinomad upgrade` on the host")
        };
        let too_old_images = || {
            "The host is too old for images (needs protocol 5.5); run `pinomad upgrade` on the host".to_string()
        };
        let mut steps = VecDeque::new();
        match call {
            Call::AddProject { path } => {
                steps.push_back(Step::Call { method: "addProject", args: obj(&[("path", Json::from(path.clone()))]) });
            }
            Call::ListFolders { path } => {
                if !host_supports_call(self.host_minor, "listFolders") {
                    return Err(too_old("5.3"));
                }
                let args = match path {
                    Some(path) => obj(&[("path", Json::from(path.clone()))]),
                    None => obj(&[]),
                };
                steps.push_back(Step::Call { method: "listFolders", args });
            }
            Call::RemoveProject { path } => {
                steps.push_back(Step::Call { method: "removeProject", args: obj(&[("path", Json::from(path.clone()))]) });
            }
            Call::RenameConversation { id, title } => {
                if !host_supports_call(self.host_minor, "renameConversation") {
                    return Err(too_old("5.4"));
                }
                let args = obj(&[
                    ("conversationId", Json::Number(*id as f64)),
                    ("title", Json::from(title.clone())),
                ]);
                steps.push_back(Step::Call { method: "renameConversation", args });
            }
            Call::CreateConversation { home, text, checkout, model, thinking_level, images } => {
                if !images.is_empty() && !host_supports_feature(self.host_minor, HostFeature::Images) {
                    return Err(too_old_images());
                }
                let mut args = JsonObject::new();
                set(&mut args, "home", home.clone());
                set(&mut args, "text", Json::from(text.clone()));
                set(&mut args, "requestId", Json::from((self.request_id)()));
                if let Some(checkout) = checkout {
                    set(&mut args, "checkout", checkout.clone());
                }
                if let Some(model) = model {
                    set(&mut args, "model", model.clone());
                }
                if let Some(level) = thinking_level {
                    set(&mut args, "thinkingLevel", Json::from(level.clone()));
                }
                if !images.is_empty() {
                    set(&mut args, "images", Json::array(images.clone()));
                }
                steps.push_back(Step::Call { method: "createConversation", args: Json::Object(Arc::new(args)) });
                steps.push_back(Step::Show { target: ShowTarget::FromResult, slot: Slot::Main });
            }
            Call::Archive { id, archived } => {
                let args = obj(&[
                    ("conversationId", Json::Number(*id as f64)),
                    ("archived", Json::Bool(*archived)),
                ]);
                steps.push_back(Step::Call { method: "archive", args });
                steps.push_back(Step::UnshowCurrentIf { id: *id, archived: *archived });
                steps.push_back(Step::UnsideIfArchived { id: *id, archived: *archived });
            }
            Call::Submit { text, when_busy, target, request_id, images } => {
                if !images.is_empty() && !host_supports_feature(self.host_minor, HostFeature::Images) {
                    return Err(too_old_images());
                }
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
                let mut args = JsonObject::new();
                set(&mut args, "conversationId", Json::Number(conversation as f64));
                set(&mut args, "text", Json::from(text.clone()));
                set(&mut args, "whenBusy", Json::from(when_busy.clone()));
                set(&mut args, "requestId", Json::from(request_id.clone().unwrap_or_else(|| (self.request_id)())));
                if !images.is_empty() {
                    set(&mut args, "images", Json::array(images.clone()));
                }
                steps.push_back(Step::Call { method: "submit", args: Json::Object(Arc::new(args)) });
            }
            Call::Compact { instructions } => {
                let conversation = self.current.ok_or_else(|| "No conversation selected".to_string())?;
                let mut args = JsonObject::new();
                set(&mut args, "conversationId", Json::Number(conversation as f64));
                if let Some(instructions) = instructions {
                    set(&mut args, "instructions", Json::from(instructions.clone()));
                }
                steps.push_back(Step::Call { method: "compact", args: Json::Object(Arc::new(args)) });
            }
            Call::Abort { target } => {
                let Some(conversation) = target.or(self.current) else {
                    // abort resolves (with a notice) without a call.
                    self.notice(Json::from("error"), Json::from("No conversation selected"));
                    steps.push_back(Step::Done { value: DoneValue::Unit });
                    return Ok(steps);
                };
                let args = obj(&[("conversationId", Json::Number(conversation as f64))]);
                steps.push_back(Step::Call { method: "abort", args });
            }
            Call::SetThinkingLevel { level } => {
                let conversation = self.current.ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[
                    ("conversationId", Json::Number(conversation as f64)),
                    ("level", Json::from(level.clone())),
                ]);
                steps.push_back(Step::Call { method: "setThinkingLevel", args });
            }
            Call::SetModel { model } => {
                let conversation = self.current.ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[
                    ("conversationId", Json::Number(conversation as f64)),
                    ("model", model.clone()),
                ]);
                steps.push_back(Step::Call { method: "setModel", args });
            }
            Call::ToggleTasks => {
                steps.push_back(Step::ToggleTasks);
            }
            Call::SwitchConversation { id } => {
                steps.push_back(Step::Show { target: ShowTarget::Id(*id), slot: Slot::Main });
            }
            Call::ShowSide { id } => match id {
                Some(id) => steps.push_back(Step::Show { target: ShowTarget::Id(*id), slot: Slot::Side }),
                None => steps.push_back(Step::Unside),
            },
            Call::Fork { entry_id, prompt, remove_tools, show } => {
                let conversation = self.current.ok_or_else(|| "No conversation selected".to_string())?;
                let mut args = JsonObject::new();
                set(&mut args, "conversationId", Json::Number(conversation as f64));
                set(&mut args, "entryId", Json::from(entry_id.clone()));
                if let Some(remove_tools) = remove_tools {
                    set(&mut args, "removeTools", Json::array(remove_tools.iter().map(|t| Json::from(t.clone())).collect()));
                }
                steps.push_back(Step::Call { method: "fork", args: Json::Object(Arc::new(args)) });
                steps.push_back(Step::Show {
                    target: ShowTarget::FromResult,
                    slot: if *show == ForkShow::Side { Slot::Side } else { Slot::Main },
                });
                steps.push_back(Step::CallForkSubmit { prompt: prompt.clone() });
            }
            Call::Answer { kind, request_id, answers, target } => {
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[
                    ("conversationId", Json::Number(conversation as f64)),
                    ("kind", Json::from(kind.clone())),
                    ("requestId", Json::from(request_id.clone())),
                    ("answers", answers.clone()),
                ]);
                steps.push_back(Step::Call { method: "answer", args });
            }
            Call::Changes => {
                let conversation = self.current.ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[("conversationId", Json::Number(conversation as f64))]);
                steps.push_back(Step::Call { method: "changes", args });
            }
            Call::CreatePairing => {
                steps.push_back(Step::Call { method: "createPairing", args: obj(&[]) });
            }
            Call::RevokeDevice { public_key } => {
                let args = obj(&[("publicKey", Json::from(public_key.clone()))]);
                steps.push_back(Step::Call { method: "revokeDevice", args });
            }
            Call::Logout { provider_id } => {
                if !host_supports_call(self.host_minor, "logout") {
                    return Err(too_old("5.1"));
                }
                let args = obj(&[("providerId", Json::from(provider_id.clone()))]);
                steps.push_back(Step::Call { method: "logout", args });
            }
            Call::UpdateSettings { patch } => {
                if !host_supports_call(self.host_minor, "updateSettings") {
                    return Err(too_old("5.2"));
                }
                if patch.get("acceptAccountDevices").is_some()
                    && !host_supports_feature(self.host_minor, HostFeature::AcceptAccountDevices)
                {
                    return Err(too_old("5.8"));
                }
                let args = obj(&[("patch", patch.clone())]);
                steps.push_back(Step::Call { method: "updateSettings", args });
            }
            Call::CreateAgent { role } => {
                if !host_supports_call(self.host_minor, "createAgent") {
                    return Err(too_old("5.6"));
                }
                let args = obj(&[("role", role.clone())]);
                steps.push_back(Step::Call { method: "createAgent", args });
            }
            Call::UpdateAgent { role } => {
                if !host_supports_call(self.host_minor, "updateAgent") {
                    return Err(too_old("5.6"));
                }
                let args = obj(&[("role", role.clone())]);
                steps.push_back(Step::Call { method: "updateAgent", args });
            }
            Call::DeleteAgent { name } => {
                if !host_supports_call(self.host_minor, "deleteAgent") {
                    return Err(too_old("5.6"));
                }
                let args = obj(&[("name", Json::from(name.clone()))]);
                steps.push_back(Step::Call { method: "deleteAgent", args });
            }
            Call::SetPushToken { token } => {
                if !host_supports_call(self.host_minor, "setPushToken") {
                    return Err(too_old("5.7"));
                }
                // The object form would be malformed to a 5.7/5.8 host — it
                // 4400s the connection, so gate it on the feature like
                // `images` (ADR-0018/0025).
                if token.is_some() && !host_supports_feature(self.host_minor, HostFeature::ApnsPush) {
                    return Err(too_old("5.9"));
                }
                let token_json = match token {
                    Some(token) => obj(&[
                        ("apns", Json::from(token.apns.clone())),
                        ("environment", Json::from(token.environment.as_str())),
                    ]),
                    None => Json::Null,
                };
                steps.push_back(Step::Call {
                    method: "setPushToken",
                    args: obj(&[("token", token_json)]),
                });
            }
        }
        steps.push_back(Step::Done { value: DoneValue::LastResult });
        Ok(steps)
    }

    /// Drive one op until it waits or finishes.
    fn drive(&mut self, index: usize) {
        loop {
            if index >= self.active.len() || self.active[index].waiting.is_some() {
                return;
            }
            let Some(step) = self.active[index].steps.pop_front() else {
                return self.complete_op(index, None);
            };
            match step {
                Step::Done { value } => {
                    let result = match value {
                        DoneValue::Unit => None,
                        DoneValue::LastResult => self.active[index].last_result.clone(),
                    };
                    return self.complete_op(index, result);
                }
                Step::Call { method, args } => {
                    if let Err(error) = self.place_call(index, method, args) {
                        return self.fail_op(index, &error);
                    }
                    return;
                }
                Step::CallForkSubmit { prompt } => {
                    let target = self.active[index]
                        .last_result
                        .as_ref()
                        .and_then(|result| result.get("conversationId"))
                        .and_then(Json::as_number)
                        .map(|v| v as u64);
                    let Some(target) = target else {
                        return self.fail_op(index, "fork result has no conversationId");
                    };
                    let mut args = JsonObject::new();
                    set(&mut args, "conversationId", Json::Number(target as f64));
                    set(&mut args, "text", Json::from(prompt));
                    set(&mut args, "whenBusy", Json::from("followUp"));
                    set(&mut args, "requestId", Json::from((self.request_id)()));
                    if let Err(error) = self.place_call(index, "submit", Json::Object(Arc::new(args))) {
                        return self.fail_op(index, &error);
                    }
                    return;
                }
                Step::Show { target, slot } => {
                    let id = match target {
                        ShowTarget::Id(id) => Some(id),
                        ShowTarget::FromResult => self.active[index]
                            .last_result
                            .as_ref()
                            .and_then(|result| result.get("conversationId"))
                            .and_then(Json::as_number)
                            .map(|v| v as u64),
                    };
                    let Some(id) = id else {
                        return self.fail_op(index, "fork result has no conversationId");
                    };
                    // `#switch`/`#showSide` early-return on the same slot.
                    if (slot == Slot::Main && Some(id) == self.current)
                        || (slot == Slot::Side && Some(id) == self.side)
                    {
                        continue;
                    }
                    // `#acquire` — subscribe missing; wait missing+stale.
                    let streams = self.conversation_streams(id);
                    let missing: Vec<Vec<u16>> = streams
                        .iter()
                        .filter(|stream| !self.wanted.contains(*stream))
                        .cloned()
                        .collect();
                    let waiting: BTreeSet<Vec<u16>> = streams
                        .iter()
                        .filter(|stream| self.wanted.contains(*stream) && !self.fresh.contains(*stream))
                        .cloned()
                        .chain(missing.iter().cloned())
                        .collect();
                    for stream in missing {
                        self.wanted.insert(stream.clone());
                        self.send(ClientFrame::Subscribe { stream: U16String(stream) });
                    }
                    if waiting.is_empty() {
                        if let Err(error) = self.apply_show(slot, id) {
                            return self.fail_op(index, &error);
                        }
                        continue;
                    }
                    self.active[index].steps.push_front(Step::ApplyShow { slot, id });
                    self.active[index].waiting = Some(Wait::Snapshots(waiting));
                    return;
                }
                Step::ApplyShow { slot, id } => {
                    if let Err(error) = self.apply_show(slot, id) {
                        return self.fail_op(index, &error);
                    }
                }
                Step::UnshowCurrentIf { id, archived } => {
                    if archived && self.current == Some(id) {
                        if let Err(error) = self.unshow() {
                            return self.fail_op(index, &error);
                        }
                    }
                }
                Step::UnsideIfArchived { id, archived } => {
                    if archived && self.side.is_some_and(|side| self.descends_from(side, id)) {
                        if let Err(error) = self.show_side(None) {
                            return self.fail_op(index, &error);
                        }
                    }
                }
                Step::Unside => {
                    if let Err(error) = self.show_side(None) {
                        return self.fail_op(index, &error);
                    }
                }
                Step::ToggleTasks => {
                    let tasks = key("tasks");
                    if self.wanted.remove(&tasks) {
                        self.send(ClientFrame::Unsubscribe { stream: U16String(tasks.clone()) });
                        self.values.remove(&tasks);
                        if let Err(error) = self.refresh() {
                            return self.fail_op(index, &error);
                        }
                    } else {
                        self.wanted.insert(tasks.clone());
                        self.send(ClientFrame::Subscribe { stream: U16String(tasks.clone()) });
                        self.active[index].waiting = Some(Wait::Snapshots(BTreeSet::from([tasks])));
                        return;
                    }
                }
            }
        }
    }

    /// `#switch`/`#showSide`'s mutation half: set the slot, release what it
    /// replaced, refresh.
    fn apply_show(&mut self, slot: Slot, id: u64) -> Result<(), String> {
        match slot {
            Slot::Main => {
                let previous = self.current;
                self.current = Some(id);
                if let Some(previous) = previous {
                    self.release(previous, self.side);
                }
            }
            Slot::Side => {
                let previous = self.side;
                self.side = Some(id);
                if let Some(previous) = previous {
                    self.release(previous, self.current);
                }
            }
        }
        self.refresh()
    }

    /// `#call` — the "Not connected" guard, then the call frame.
    fn place_call(&mut self, index: usize, method: &'static str, args: Json) -> Result<(), String> {
        let connected = self
            .state
            .as_ref()
            .and_then(|state| state.get(&key("connection")))
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy() == CONNECTED)
            .unwrap_or(false);
        if self.conn.is_none() || !connected {
            return Err("Not connected to the host".to_string());
        }
        let id = self.next_call;
        self.next_call += 1;
        self.pending_calls.insert(id, self.active[index].op_id);
        self.active[index].waiting = Some(Wait::Call);
        self.send(ClientFrame::Call { id: id as f64, method: U16String::from_str(method), args });
        Ok(())
    }

    /// Op finished: result to the caller, then the queue continues.
    fn complete_op(&mut self, index: usize, value: Option<Json>) {
        let op = self.active.remove(index);
        self.out.push(Command::OperationSucceeded { op: op.op_id, value });
        self.pump();
    }

    /// Op failed mid-flight: a request reports the error; commands and the
    /// unqueued abort turn it into a notice and still report success —
    /// the #command/#request split plus abort's `.then(()=>{}, notice)`.
    fn fail_op(&mut self, index: usize, error: &str) {
        let op = self.active.remove(index);
        self.finish_failed(op.op_id, op.kind, error);
    }

    fn finish_failed(&mut self, op_id: u64, kind: OpKind, error: &str) {
        match kind {
            OpKind::Request => {
                self.out.push(Command::OperationFailed { op: op_id, error: error.to_string() });
            }
            OpKind::Command | OpKind::Unqueued => {
                self.notice(Json::from("error"), Json::from(error.to_string()));
                self.out.push(Command::OperationSucceeded { op: op_id, value: None });
            }
        }
        self.pump();
    }

    // ─── Conversation slots ─────────────────────────────────────────────

    /// `#conversationStreams` — a conversation's view plus its documents.
    fn conversation_streams(&self, id: u64) -> Vec<Vec<u16>> {
        let mut streams = vec![conversation_stream(id).0];
        for doc in &self.docs {
            streams.push(doc_stream(&U16String::js_string(&doc.kind), id).0);
        }
        streams
    }

    /// `#release` — unsubscribe the streams of one slot's conversation the
    /// other slot does not still need.
    fn release(&mut self, id: u64, other: Option<u64>) {
        let keep: HashSet<Vec<u16>> = other
            .map(|other| self.conversation_streams(other).into_iter().collect())
            .unwrap_or_default();
        for stream in self.conversation_streams(id) {
            if keep.contains(&stream) {
                continue;
            }
            self.wanted.remove(&stream);
            self.values.remove(&stream);
            self.fresh.remove(&stream);
            self.send(ClientFrame::Unsubscribe { stream: U16String(stream) });
        }
    }

    /// `#unshow` — drop the main slot.
    fn unshow(&mut self) -> Result<(), String> {
        let Some(previous) = self.current.take() else {
            return Ok(());
        };
        self.release(previous, self.side);
        self.refresh()
    }

    /// `#showSide(id)` with the id already resolved (None → close the slot).
    fn show_side(&mut self, id: Option<u64>) -> Result<(), String> {
        let previous = self.side;
        self.side = id;
        if let Some(previous) = previous {
            self.release(previous, self.current);
        }
        self.refresh()
    }

    /// `#descendsFrom` — walk parent links, bounded like the reference.
    fn descends_from(&self, id: u64, ancestor: u64) -> bool {
        let summaries = self
            .values
            .get(&key("conversations"))
            .and_then(Json::as_array)
            .map(|a| a.as_ref().clone())
            .unwrap_or_default();
        let parent_of: HashMap<u64, u64> = summaries
            .iter()
            .filter_map(|summary| {
                let sid = num_id(summary.get("id"))?;
                let parent = num_id(summary.get("parent"))?;
                Some((sid, parent))
            })
            .collect();
        let mut cursor = Some(id);
        for _ in 0..8 {
            let Some(id) = cursor else { break };
            if id == ancestor {
                return true;
            }
            cursor = parent_of.get(&id).copied();
        }
        false
    }

    // ─── View derivation ────────────────────────────────────────────────

    /// `#hostInfo` — the announced protocol and packaged version.
    fn host_info(&self) -> Json {
        let mut object = JsonObject::new();
        let mut protocol = JsonObject::new();
        set(&mut protocol, "major", Json::Number(PROTOCOL.major as f64));
        set(&mut protocol, "minor", Json::Number(self.host_minor as f64));
        set(&mut object, "protocol", Json::Object(Arc::new(protocol)));
        if let Some(version) = &self.host_version {
            set(&mut object, "version", version.clone());
        }
        Json::Object(Arc::new(object))
    }

    fn set_field(&mut self, name: &str, value: Json) {
        if let Some(state) = &mut self.state {
            state.set(U16String::from_str(name), value);
            self.view_dirty = true;
        }
    }

    /// A field JS would set to `undefined` simply disappears.
    fn set_or_clear(&mut self, name: &str, value: Option<Json>) {
        match value {
            Some(value) => self.set_field(name, value),
            None => {
                if let Some(state) = &mut self.state {
                    if state.get(&key(name)).is_some() {
                        state.remove(&key(name));
                        self.view_dirty = true;
                    }
                }
            }
        }
    }

    /// `#notice` — append to the capped notice list.
    fn notice(&mut self, level: Json, message: Json) {
        if self.state.is_none() {
            return;
        }
        let id = self.next_notice;
        self.next_notice += 1;
        let mut entry = JsonObject::new();
        set(&mut entry, "id", Json::Number(id as f64));
        set(&mut entry, "level", level);
        set(&mut entry, "message", message);
        let mut notices = self
            .state
            .as_ref()
            .and_then(|state| state.get(&key("notices")))
            .and_then(Json::as_array)
            .map(|a| a.as_ref().clone())
            .unwrap_or_default();
        notices.push(Json::Object(Arc::new(entry)));
        if notices.len() > 20 {
            notices.drain(..notices.len() - 20);
        }
        self.set_field("notices", Json::array(notices));
    }

    /// `#docsOf` — one shown conversation's extension docs.
    fn docs_of(&self, id: u64) -> Json {
        let items: Vec<Json> = self
            .docs
            .iter()
            .filter_map(|doc| {
                let stream = doc_stream(&U16String::js_string(&doc.kind), id).0;
                self.values.get(&stream).map(|value| {
                    let mut object = JsonObject::new();
                    set(&mut object, "kind", doc.kind.clone());
                    if let Some(presentation) = &doc.presentation {
                        set(&mut object, "presentation", presentation.clone());
                    }
                    set(&mut object, "value", value.clone());
                    Json::Object(Arc::new(object))
                })
            })
            .collect();
        Json::array(items)
    }

    /// `#effectiveDefaults` — settings stream wins once it arrived.
    fn effective_defaults(&self) -> Json {
        match self.values.get(&key("settings")) {
            Some(settings) => {
                let mut object = JsonObject::new();
                if let Some(model) = settings.get("defaultModel").filter(|m| !matches!(m, Json::Null)) {
                    set(&mut object, "model", model.clone());
                }
                if let Some(level) = settings.get("defaultThinkingLevel").filter(|l| !matches!(l, Json::Null)) {
                    set(&mut object, "thinkingLevel", level.clone());
                }
                Json::Object(Arc::new(object))
            }
            None => self.hello_defaults.clone(),
        }
    }

    /// `#refresh` — recompute the derived view fields. Every input is read
    /// before anything is written, so a failure leaves the view untouched,
    /// like the reference building the patch object first.
    fn refresh(&mut self) -> Result<(), String> {
        if self.state.is_none() {
            return Ok(());
        }
        let summaries: Vec<Json> = self
            .values
            .get(&key("conversations"))
            .and_then(Json::as_array)
            .map(|a| a.as_ref().clone())
            .unwrap_or_default();
        let index = self.values.get(&key("index")).cloned().unwrap_or_else(|| {
            let mut object = JsonObject::new();
            set(&mut object, "projects", Json::array(vec![]));
            set(&mut object, "conversations", Json::array(vec![]));
            Json::Object(Arc::new(object))
        });
        let devices = self
            .values
            .get(&key("devices"))
            .and_then(|v| v.get("devices").cloned())
            .unwrap_or_else(|| Json::array(vec![]));
        let tasks = if self.wanted.contains(&key("tasks")) {
            self.values.get(&key("tasks")).cloned()
        } else {
            None
        };
        let conversation = self.current.and_then(|id| self.values.get(&conversation_stream(id).0).cloned());
        let organized = organize(&index, &summaries)?.to_json();
        let docs = self.current.map(|id| self.docs_of(id));
        let side = self.side.map(|id| {
            let mut object = JsonObject::new();
            set(&mut object, "id", Json::Number(id as f64));
            if let Some(value) = self.values.get(&conversation_stream(id).0) {
                set(&mut object, "conversation", value.clone());
            }
            set(&mut object, "docs", self.docs_of(id));
            Json::Object(Arc::new(object))
        });
        let models = self.values.get(&key("models")).cloned().unwrap_or_else(|| self.hello_models.clone());
        let mcp = self.values.get(&key("mcp")).cloned().unwrap_or(Json::Null);
        let auth = self.values.get(&key("auth")).cloned().unwrap_or(Json::Null);
        let settings = self.values.get(&key("settings")).cloned().unwrap_or(Json::Null);
        let agents = self.values.get(&key("agents")).cloned().unwrap_or(Json::Null);
        let defaults = self.effective_defaults();
        self.set_or_clear("conversation", conversation);
        self.set_field("models", models);
        self.set_field("organized", organized);
        self.set_or_clear("home", self.current.and_then(|id| home_of(&index, &summaries, id)).map(|h| h.to_json()));
        self.set_or_clear("checkout", self.current.and_then(|id| checkout_of(&index, &summaries, id)).map(|c| c.to_json()));
        self.set_or_clear("tasks", tasks);
        self.set_field("docs", docs.unwrap_or_else(|| Json::array(vec![])));
        self.set_or_clear("side", side);
        self.set_field("devices", devices);
        self.set_field("mcp", mcp);
        self.set_field("auth", auth);
        self.set_field("settings", settings);
        self.set_field("agents", agents);
        self.set_field("defaults", defaults);
        Ok(())
    }

    /// `#awaitFirstView`'s completion — build the initial view and report.
    fn finish_first_view(&mut self) {
        let Some(first) = self.first_view.take() else {
            return;
        };
        let hello = &first.hello;
        let mut state = JsonObject::new();
        if let Some(session) = hello.get("session") {
            set(&mut state, "session", session.clone());
        }
        let mut organized = JsonObject::new();
        set(&mut organized, "chats", Json::array(vec![]));
        set(&mut organized, "projects", Json::array(vec![]));
        set(&mut organized, "archived", Json::array(vec![]));
        set(&mut state, "organized", Json::Object(Arc::new(organized)));
        set(
            &mut state,
            "models",
            self.values
                .get(&key("models"))
                .cloned()
                .unwrap_or_else(|| hello.get("models").cloned().unwrap_or(Json::Null)),
        );
        set(&mut state, "defaults", self.effective_defaults());
        set(&mut state, "notices", Json::array(vec![]));
        set(&mut state, "connection", Json::from(CONNECTED));
        set(&mut state, "docs", Json::array(vec![]));
        if let Some(presentations) = hello.get("toolPresentations") {
            set(&mut state, "toolPresentations", presentations.clone());
        }
        set(&mut state, "devices", Json::array(vec![]));
        set(&mut state, "mcp", Json::Null);
        set(&mut state, "auth", Json::Null);
        set(&mut state, "settings", Json::Null);
        set(&mut state, "agents", Json::Null);
        set(&mut state, "host", self.host_info());
        self.state = Some(state);
        if let Err(error) = self.refresh() {
            self.state = None;
            return self.fail_channel(&error);
        }
        if !self.ready_sent {
            self.ready_sent = true;
            self.out.push(Command::Ready { outcome: ReadyOutcome::Connected });
        }
    }
}

fn num_id(value: Option<&Json>) -> Option<u64> {
    value
        .and_then(Json::as_number)
        .filter(|v| v.fract() == 0.0 && *v >= 0.0 && *v <= u64::MAX as f64)
        .map(|v| v as u64)
}

/// `String(number)` — used for the protocol-mismatch notice text, where JS
/// prints NaN/Infinity too.
fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value == f64::INFINITY {
        "Infinity".to_string()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        crate::json::number_to_json(value)
    }
}

fn default_request_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("system random source");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// hello.docs → doc declarations. `frame.docs` is trusted like the
/// reference — but where the reference would TypeError later (`.map` on a
/// non-array) this fails at the hello, which closes the channel either way.
fn parse_docs(frame: &Json) -> Result<Vec<DocDecl>, String> {
    let docs = frame.get("docs").and_then(Json::as_array).ok_or_else(|| "malformed hello: docs".to_string())?;
    Ok(docs
        .iter()
        .map(|doc| DocDecl {
            kind: doc.get("kind").cloned().unwrap_or(Json::Null),
            presentation: doc.get("presentation").cloned(),
        })
        .collect())
}

fn obj(fields: &[(&str, Json)]) -> Json {
    let mut object = JsonObject::new();
    for (name, value) in fields {
        set(&mut object, name, value.clone());
    }
    Json::Object(Arc::new(object))
}

fn set(obj: &mut JsonObject, name: &str, value: Json) {
    obj.set(U16String::from_str(name), value);
}

// The UniFFI facade parks the state machine behind a Mutex on an arbitrary
// platform thread; anything that stops being Send must fail here, loudly.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<RemoteDurable>();
};
