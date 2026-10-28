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

use crate::connection_mode::ConnectionMode;
use crate::delta::{apply_immutable, op_from_json};
use crate::endpoints::{EndpointSet, ParsedEndpointSet, parse_endpoint_set};
use crate::frames::{
    ApnsPushToken, ClientFrame, HostFeature, HostRtc, ImageVariant, PROTOCOL, RtcMaxMessageSize,
    ServerFrame, UNAUTHORIZED_CLOSE_CODE, classify_server_frame, conversation_stream, doc_stream,
    encode_client_frame, host_streams, host_supports_call, host_supports_feature, minor_version,
    parse_host_rtc, parse_rtc_max_message_size,
};
use crate::json::{Json, JsonObject};
use crate::organization::{checkout_of, home_of, organize};
use crate::remote_candidates::{
    DIRECT_UNAVAILABLE, RemoteCandidate, RemoteCandidateRole, candidate_plan,
    filter_candidates_for_mode, preferred_legacy_url, signal_candidates,
};
use crate::secure_channel::{
    IkClientHandshake, SECURE_PROLOGUE, SecureSession, initiate_handshake_with_prologue,
};
use crate::b64::from_base64url;
use crate::noise::{KeyPair, keypair_from_private};
use crate::rtc::{RtcCandidateInfo, RtcSelectedPair, rtc_selected_pair};
use crate::transport::{ConnOut, Connection, Transport};
use crate::u16str::U16String;

const DEFAULT_RECONNECT_MIN_MS: u64 = 200;
const DEFAULT_RECONNECT_MAX_MS: u64 = 2000;
/// One message may reference this many host-stored attachments (issue #321).
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;
const CONNECTED: &str = "connected";
const RECONNECTING: &str = "reconnecting";
const CLOSED: &str = "closed";
const OUTDATED: &str = "outdated";

const REMOTE_ACCESS_UNAVAILABLE: &str = "Remote access is unavailable: the host published no remote path and this device has no local entry.";

/// Whether this client follows a hello's endpoint set. The distinction is
/// explicit because an empty planned list is a real "no remote entry", while
/// a single carrier must never be replaced by a hello set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteMode {
    Single,
    Planned,
}

/// Per-candidate deadlines, matching packages/protocol/src/remote-durable.ts.
/// Every stage is bounded and a retired candidate cancels its timer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CandidateTimeouts {
    pub socket_open_ms: u64,
    pub noise_ms: u64,
    pub hello_ms: u64,
    pub sync_ms: u64,
}

impl Default for CandidateTimeouts {
    fn default() -> Self {
        CandidateTimeouts {
            socket_open_ms: 5_000,
            noise_ms: 5_000,
            hello_ms: 5_000,
            sync_ms: 10_000,
        }
    }
}

/// Which phase a candidate failed in, for the per-path diagnostics a round
/// aggregates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateFailureStage {
    Unsupported,
    Open,
    Noise,
    Hello,
    Sync,
    Round,
    Closed,
}

impl CandidateFailureStage {
    pub fn as_str(self) -> &'static str {
        match self {
            CandidateFailureStage::Unsupported => "unsupported",
            CandidateFailureStage::Open => "open",
            CandidateFailureStage::Noise => "noise",
            CandidateFailureStage::Hello => "hello",
            CandidateFailureStage::Sync => "sync",
            CandidateFailureStage::Round => "round",
            CandidateFailureStage::Closed => "closed",
        }
    }
}

/// What a WebRTC library did with one record (ADR-0033 §2). Node's `false`
/// is already queued; str0m's `false` is not accepted and may be retried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RtcSendOutcome {
    Accepted,
    Queued,
    Rejected,
}

/// The RTC capability handed to the coordinator. Its presence is the platform
/// declaration; `None` means the core never creates a peer or a signal
/// connection and emits no RTC command.
#[derive(Clone, Debug)]
pub struct RtcOptions {
    /// base64url of the host's 32-byte Noise static key.
    pub host_key: String,
    /// base64url of this device's 32-byte Noise private key.
    pub device_private_key: String,
    /// The stored `hello.rtc.signalOnly` hint for Direct only.
    pub signal_only_hint: bool,
}

impl RtcOptions {
    fn keys(&self) -> Option<(KeyPair, [u8; 32])> {
        let private = from_base64url(&self.device_private_key).ok()?;
        let device = keypair_from_private(&private).ok()?;
        let host = from_base64url(&self.host_key).ok()?;
        let host: [u8; 32] = host.try_into().ok()?;
        Some((device, host))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionPath {
    Loopback,
    Relay,
    Direct,
    P2p,
}

impl ConnectionPath {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectionPath::Loopback => "loopback",
            ConnectionPath::Relay => "relay",
            ConnectionPath::Direct => "direct",
            ConnectionPath::P2p => "p2p",
        }
    }
}

/// One path's failure evidence. `unauthorized` is only true for a raw 4401
/// close, which says nothing about the host's other paths until the round
/// ends.
#[derive(Clone, Debug)]
pub struct CandidateFailure {
    pub candidate: RemoteCandidate,
    pub stage: CandidateFailureStage,
    pub unauthorized: bool,
    pub code: Option<u16>,
    pub reason: Option<String>,
}

/// One connection source per round. The coordinator builds every candidate's
/// carrier with the same device identity; only the socket URL changes.
pub trait CandidateSource: Send {
    /// Open one carrier generation for `candidate`.
    fn open(&mut self, candidate: &RemoteCandidate) -> Box<dyn Connection>;
    /// Open a signal-only carrier (SIGNAL_PROLOGUE) for a relay candidate.
    /// Sources without RTC support never reach this; the default keeps the
    /// old test carriers and non-RTC clients source-compatible.
    fn open_signal(&mut self, candidate: &RemoteCandidate) -> Box<dyn Connection> {
        self.open(candidate)
    }
    /// The generation that just authenticated carried the invitation: spend
    /// the shared secret and report what the platform persists. Sources that
    /// never pair return None.
    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        None
    }
}

/// The legacy single-carrier mode: one transport object opens every
/// generation, and a hello endpoint set does not rebuild the plan.
pub struct SingleSource {
    transport: Box<dyn Transport>,
}

impl SingleSource {
    pub fn new(transport: Box<dyn Transport>) -> Self {
        SingleSource { transport }
    }
}

impl CandidateSource for SingleSource {
    fn open(&mut self, _candidate: &RemoteCandidate) -> Box<dyn Connection> {
        self.transport.open()
    }

    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        self.transport.mark_paired()
    }
}

/// Multi-candidate mode: the plan may be replaced by a validated hello, and
/// each open asks the factory for a carrier bound to that URL.
pub struct PlannedSource {
    open: Box<dyn FnMut(&RemoteCandidate) -> Box<dyn Transport> + Send>,
    current: Option<Box<dyn Transport>>,
}

impl PlannedSource {
    pub fn new(open: Box<dyn FnMut(&RemoteCandidate) -> Box<dyn Transport> + Send>) -> Self {
        PlannedSource {
            open,
            current: None,
        }
    }
}

impl CandidateSource for PlannedSource {
    fn open(&mut self, candidate: &RemoteCandidate) -> Box<dyn Connection> {
        let mut transport = (self.open)(candidate);
        let connection = transport.open();
        self.current = Some(transport);
        connection
    }

    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        self.current.as_mut()?.mark_paired()
    }
}

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
        /// A named agent to create the conversation with (ADR-0023); needs
        /// a 5.10 host — gated before send, never silently dropped.
        agent: Option<String>,
        images: Vec<Json>,
        /// The `$` menu picks, deduplicated, in mention order (ADR-0028):
        /// sent to a 5.16 host — `Some(vec![])` expands nothing, `None`
        /// leaves the host matching `$name` in the text.
        skills: Option<Vec<String>>,
        /// Host-stored attachment ids to reference (issue #321); a 5.19 host
        /// only — an older one calls the field malformed and 4400s.
        attachments: Vec<String>,
    },
    Archive { id: u64, archived: bool },
    Submit {
        text: String,
        when_busy: String,
        target: Option<u64>,
        request_id: Option<String>,
        images: Vec<Json>,
        /// The `$` menu picks, deduplicated, in mention order (ADR-0028):
        /// sent to a 5.16 host — `Some(vec![])` expands nothing, `None`
        /// leaves the host matching `$name` in the text.
        skills: Option<Vec<String>>,
        /// Host-stored attachment ids to reference (issue #321); 5.19 only.
        attachments: Vec<String>,
    },
    /// Take a queued input back out of the inbox (5.14). `sent` means it
    /// already reached the transcript. Request-class: the caller owns the
    /// outcome and the error.
    WithdrawQueued { submission_id: u64, target: Option<u64> },
    /// Promote a queued follow-up to steer in place (5.14); it is placed at
    /// the next boundary that takes steers, in queue order. Request-class.
    SteerQueued { submission_id: u64, target: Option<u64> },
    Compact { instructions: Option<String> },
    /// `runCommand` — run the host-declared command `name` on `target`
    /// (the shown conversation by default); `args` is the text after the
    /// name (ADR-0029). Command-class like `compact`: queued, and a failure
    /// (an unknown name, a pre-5.17 host) lands as a notice. Needs 5.17.
    RunCommand { name: String, args: Option<String>, target: Option<u64> },
    /// Not queued behind the command chain — it resolves once the
    /// conversation is idle, same as the reference.
    Abort { target: Option<u64> },
    SetThinkingLevel { level: String },
    SetModel { model: Json },
    /// `setAgent` — switch the shown conversation to a named agent, or clear
    /// it with `None` (ADR-0023, protocol 5.18). Needs a 5.18 host.
    SetAgent { agent: Option<String> },
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
    /// `target` defaults to the shown conversation, like `submit`'s.
    Changes { target: Option<u64> },
    CreatePairing,
    RevokeDevice { public_key: String },
    Logout { provider_id: String },
    /// `beginLogin` — start a login (5.21, ADR-0031); its prompts and
    /// outcome arrive in the `providers` stream's `logins`. Request-class,
    /// like the provider calls below: the caller shows the host's error.
    /// The result is the host's `{ loginId }`.
    BeginLogin { provider_id: String, method: LoginMethod },
    /// `answerLogin` — answer a running login's current prompt (5.21).
    AnswerLogin { login_id: String, prompt_id: u64, value: String },
    /// `cancelLogin` — abort a running login (5.21).
    CancelLogin { login_id: String },
    /// `saveCustomProvider` — add or replace a custom endpoint (5.21);
    /// `provider` is a `CustomProviderInput`.
    SaveCustomProvider { provider: Json, api_key: ApiKeyChange },
    /// `removeCustomProvider` — remove a custom endpoint and its key (5.21).
    RemoveCustomProvider { provider_id: String },
    /// `listEndpointModels` — the models an endpoint serves, asked from the
    /// host (5.21). Unqueued like `listCommands`: the host waits on a remote
    /// endpoint. The result is the host's `{ models }`.
    ListEndpointModels {
        api: CustomProviderApi,
        base_url: String,
        api_key: Option<String>,
        provider_id: Option<String>,
    },
    UpdateSettings { patch: Json },
    CreateAgent { role: Json },
    UpdateAgent { role: Json },
    DeleteAgent { name: String },
    /// `setPushToken` — register (`Some`) or deregister (`None`) this
    /// device's APNs token. The API only exposes the APNs object form:
    /// the legacy Expo string still parses on the host but is refused,
    /// and the platform layer never sends it (ADR-0025 §7).
    SetPushToken { token: Option<ApnsPushToken> },
    /// `listFiles` — file candidates for `@./path` completion. A read-only
    /// request sent outside the command queue: a slow scan must not block
    /// commands behind it, and a hanging command must not block it. Needs
    /// a 5.10 host.
    ListFiles { scope: Json, query: String },
    /// `listSkills` — the `$`-mentionable skills for a scope (issue #143).
    /// Same read-only, unqueued shape as `listFiles`. Needs a 5.13 host.
    ListSkills { scope: Json },
    /// `image` — the bytes behind a ref this connection's conversation
    /// stream was shown (5.15, ADR-0027). Read-only and unqueued like
    /// `listFiles`: a slow fetch must not hold up commands, and a hung
    /// command must not hide a picture the screen already needs.
    Image { ref_: String, variant: ImageVariant },
    /// `listCommands` — the slash commands the host declares for a
    /// conversation (ADR-0029). Same read-only, unqueued shape as
    /// `listSkills`. Needs a 5.17 host.
    ListCommands { conversation_id: u64 },
    /// `beginAttachment` — create one host-stored upload slot (5.19, issue
    /// #321). Read-only in the same sense as `listFiles`: unqueued, so a
    /// chunk upload never waits behind a submit and never blocks one.
    BeginAttachment { name: String, size: u64 },
    /// `appendAttachment` — append one base64 chunk at `offset` (5.19).
    AppendAttachment { attachment_id: String, offset: u64, data: String },
    /// Retry a logical submission with the same requestId and fixed target.
    RetrySubmission { request_id: String },
    /// Take a failed or confirmed-unadmitted logical submission back for editing.
    TakeBackSubmission { request_id: String },
}

/// Why a message's attachment ids can't be sent, or `Ok` when they can.
/// The host enforces both rules too; this is the local refusal that keeps a
/// pre-5.19 host from 4400-ing the connection.
fn check_attachments(host_minor: u32, attachments: &[String]) -> Result<(), String> {
    if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(format!("At most {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message"));
    }
    if !attachments.is_empty() && !host_supports_feature(host_minor, HostFeature::Attachments) {
        return Err(
            "The host is too old for attachments (needs protocol 5.19); run `pinomad upgrade` on the host"
                .to_string(),
        );
    }
    Ok(())
}

/// Put `attachments` on a `submit`/`createConversation` args object;
/// an empty list is omitted, like images.
fn set_attachments(args: &mut JsonObject, attachments: &[String]) {
    if !attachments.is_empty() {
        set(
            args,
            "attachments",
            Json::array(attachments.iter().map(|id| Json::from(id.clone())).collect()),
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ForkShow {
    Main,
    Side,
}

/// `LoginMethod` (auth.ts) — how a login is done.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LoginMethod {
    Oauth,
    ApiKey,
}

impl LoginMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginMethod::Oauth => "oauth",
            LoginMethod::ApiKey => "api_key",
        }
    }
}

/// `CustomProviderApi` (auth.ts) — the wire formats a custom endpoint may
/// speak. Typed because the host 4400s a call whose `api` it doesn't know.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CustomProviderApi {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
    GoogleGenerativeAi,
}

impl CustomProviderApi {
    pub fn as_str(self) -> &'static str {
        match self {
            CustomProviderApi::OpenaiCompletions => "openai-completions",
            CustomProviderApi::OpenaiResponses => "openai-responses",
            CustomProviderApi::AnthropicMessages => "anthropic-messages",
            CustomProviderApi::GoogleGenerativeAi => "google-generative-ai",
        }
    }
}

/// `saveCustomProvider`'s `apiKey`: absent keeps the stored key, `null`
/// removes it, a string stores it.
#[derive(Clone, Debug, PartialEq)]
pub enum ApiKeyChange {
    Keep,
    Remove,
    Set(String),
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
    /// Monotonic platform time for cooldown diagnostics and stall checks.
    Clock { now_ms: u64 },
    /// The platform created the offer and gathered candidates (its own 2s).
    RtcPeerReady { peer: u32, sdp: String },
    /// The reliable ordered DataChannel opened.
    RtcChannelOpened { peer: u32 },
    /// One inbound DataChannel record.
    RtcData { peer: u32, bytes: Vec<u8> },
    /// The library's verdict on the last `RtcSend`.
    RtcSendResult { peer: u32, outcome: RtcSendOutcome },
    /// The library's low-water callback; resume the record pump.
    RtcLowWater { peer: u32 },
    /// The DataChannel / ICE closed. Candidate-level, never unauthorized.
    RtcClosed { peer: u32, reason: Option<String> },
    /// The selected ICE pair's raw ends, for diagnostics.
    RtcSelectedCandidate {
        peer: u32,
        local: RtcCandidateInfo,
        remote: RtcCandidateInfo,
    },
    /// Switch connection mode; the whole client reconnects (ADR-0033 §3).
    SetConnectionMode { mode: ConnectionMode },
}

/// Everything the platform layer executes — open/write/close a socket,
/// arm a timer, persist a completed pairing, surface readiness, observe the
/// view, and resolve operations by their caller's id.
#[derive(Debug)]
pub enum Command {
    OpenConnection {
        conn: u32,
        url: String,
    },
    SendBytes {
        conn: u32,
        bytes: Vec<u8>,
    },
    CloseSocket {
        conn: u32,
    },
    /// Arm the reconnect timer; `timer` is echoed back via TimerFired.
    ScheduleReconnect {
        timer: u32,
        delay_ms: u64,
    },
    /// Drop a previously armed reconnect timer — an early reconnect or a
    /// closed session makes it dead. Platforms holding real timers (iOS
    /// suspends them in the background) must not wake for it.
    CancelReconnect {
        timer: u32,
    },
    /// Arm one candidate-stage or whole-round deadline. The id is echoed by
    /// TimerFired and is dead once canceled.
    ScheduleDeadline {
        timer: u32,
        delay_ms: u64,
    },
    CancelDeadline {
        timer: u32,
    },
    Ready {
        outcome: ReadyOutcome,
    },
    /// `view()` changed; read it again. Emitted at most once per handle().
    ViewChanged,
    /// One candidate failed; the round continues and aggregates these.
    CandidateFailed {
        failure: CandidateFailure,
    },
    /// A validated (possibly empty) hello endpoint set, with the legacy URL
    /// old clients should see. The platform updates only that host record.
    EndpointSet {
        host_key: String,
        url: String,
        endpoint_set: EndpointSet,
    },
    /// First channel with a pairing secret authenticated: what the app
    /// persists — where, which host, which device key, and the invite's set.
    Paired {
        url: String,
        host_key: String,
        private_key: String,
        endpoint_set: Option<EndpointSet>,
    },
    OperationSucceeded {
        op: u64,
        value: Option<Json>,
    },
    OperationFailed {
        op: u64,
        error: String,
        /// The connection or Peer that carried the request is gone, so the
        /// host may have applied it before the reply was lost.
        carrier_lost: bool,
    },
    /// The host announced signal-only RTC (or a failed handshake disproved
    /// it); persist the hint with the stored host.
    RtcSignalOnly { host_key: String, signal_only: bool },
    /// Create the offer and DataChannel; the platform reports `RtcPeerReady`.
    CreateRtcPeer { peer: u32, stun: Vec<String> },
    /// Apply the host's complete answer and start ICE.
    AcceptRtcAnswer { peer: u32, sdp: String },
    /// Hand one record to the DataChannel. One in flight at a time.
    RtcSend { peer: u32, bytes: Vec<u8> },
    /// Retire the Peer and its DataChannel.
    CloseRtcPeer { peer: u32 },
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
    /// Direct only could not reach the host: the relay is out of bounds for
    /// business data and the peer-to-peer link did not come up. `reason` is
    /// the last preparation failure, kept separate so the UI need not parse
    /// the message string (the TS `DirectUnavailableError`).
    DirectUnavailable { reason: String },
    Error(String),
}

pub struct RemoteDurableOptions {
    pub source: Box<dyn CandidateSource>,
    /// Single never follows hello endpoint sets; Planned always may.
    pub mode: RemoteMode,
    /// `reconnectDelayMs` — {min,max} backoff seed.
    pub reconnect_delay_ms: Option<(u64, u64)>,
    /// `newRequestId` — a fresh 32-hex-char id per submit/fork; injected so
    /// tests can be deterministic and FFI hosts can supply their own RNG.
    pub request_id: Option<Box<dyn FnMut() -> String + Send>>,
    /// The planned candidate list for round one. In `Planned` mode an empty
    /// list is a real "no remote entry"; `Single` ignores it and derives its
    /// one carrier from `legacy_url`.
    pub candidates: Vec<RemoteCandidate>,
    /// The record's legacy URL (loopback entries stay local across hello
    /// updates). Defaults to the first candidate.
    pub legacy_url: Option<String>,
    pub page_protocol: Option<String>,
    /// The host's fixed key, for EndpointSet storage updates.
    pub host_key: String,
    /// The invitation's candidate set, persisted as soon as message 2 lands.
    pub pairing_endpoint_set: Option<EndpointSet>,
    pub candidate_timeouts: CandidateTimeouts,
    /// Cap a whole round; defaults to every candidate's stage budgets plus a
    /// small margin so a later candidate always gets its turn.
    pub round_timeout_ms: Option<u64>,
    /// Defaults to Auto.
    pub connection_mode: ConnectionMode,
    /// Absent means the platform cannot do RTC; the core then behaves exactly
    /// as before and never emits an RTC command.
    pub rtc: Option<RtcOptions>,
    /// Track submissions until the host's entry or inbox row replaces them
    /// (ADR-0034). Off by default: iOS keeps the pre-PR-3 behavior until the
    /// Web client's reconciliation has a native UI.
    pub logical_submissions: bool,
}

impl RemoteDurableOptions {
    /// Legacy single-carrier options: one URL, one transport, no endpoint
    /// following. The candidate coordinator still gives it the same staged
    /// deadlines and retry loop.
    pub fn single(transport: Box<dyn Transport>) -> Self {
        let url = transport.url().to_string();
        RemoteDurableOptions {
            source: Box::new(SingleSource::new(transport)),
            mode: RemoteMode::Single,
            reconnect_delay_ms: None,
            request_id: None,
            candidates: candidate_plan(&url, None, None),
            legacy_url: Some(url),
            page_protocol: None,
            host_key: String::new(),
            pairing_endpoint_set: None,
            candidate_timeouts: CandidateTimeouts::default(),
            round_timeout_ms: None,
            connection_mode: ConnectionMode::Auto,
            rtc: None,
            logical_submissions: false,
        }
    }
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
    /// `listFiles` / `listSkills` / `image` — not part of the serialized
    /// chain either, but the caller owns the result like a Request: a
    /// read-only query resolves with the host's answer or its error.
    Direct,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubmissionPhase {
    Queued,
    InFlight,
    Unknown,
    Failed,
    Settled,
}

impl SubmissionPhase {
    fn as_str(self) -> &'static str {
        match self {
            SubmissionPhase::Queued => "queued",
            SubmissionPhase::InFlight => "inFlight",
            SubmissionPhase::Unknown => "unknown",
            SubmissionPhase::Failed => "failed",
            SubmissionPhase::Settled => "settled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubmissionPlacement {
    Conversation,
    Queue,
}

impl SubmissionPlacement {
    fn as_str(self) -> &'static str {
        match self {
            SubmissionPlacement::Conversation => "conversation",
            SubmissionPlacement::Queue => "queue",
        }
    }
}

/// One client-side send before the host's own fact replaces it (ADR-0034 §5).
struct SubmissionRecord {
    request_id: String,
    text: String,
    when_busy: String,
    placement: SubmissionPlacement,
    phase: SubmissionPhase,
    images: Vec<Json>,
    skills: Option<Vec<String>>,
    attachments: Vec<String>,
    conversation_id: Option<u64>,
    fixed: bool,
    submission_id: Option<u64>,
    entry: Option<u64>,
    error: Option<String>,
    timer: Option<u32>,
    /// Admission is confirmed; no timeout applies while waiting for its entry.
    admitted: bool,
    confirming: bool,
    /// Snapshot version last checked for a missing entry.
    checked_version: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubmissionQuery {
    Confirm(usize),
    RecoveryQuery(usize),
    RecoveryResend(usize),
    RetryQuery(usize, u64),
    RetryResend(usize, u64),
    TakeBackQuery(usize, u64),
    TakeBackWithdraw(usize, u64),
}

/// One in-flight controller operation.
struct ActiveOp {
    op_id: u64,
    kind: OpKind,
    /// Whether this op blocks the serialized queue (commands and requests).
    holds_queue: bool,
    steps: VecDeque<Step>,
    waiting: Option<Wait>,
    /// The carrier that actually took this op's call frame. A retirement of
    /// any other connection must not turn its failure into "reply lost".
    carrier: Option<CallCarrier>,
    /// The last call result (for follow-on steps like fork's submit).
    last_result: Option<Json>,
}

/// What a request's call frame went out on. One business carrier at a time:
/// the dial connection, or the RTC Peer after the handoff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallCarrier {
    Conn(u32),
    Peer(u32),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Open,
    Noise,
    Hello,
    Sync,
    Ready,
}

impl Phase {
    fn stage(self) -> CandidateFailureStage {
        match self {
            Phase::Open => CandidateFailureStage::Open,
            Phase::Noise => CandidateFailureStage::Noise,
            Phase::Hello => CandidateFailureStage::Hello,
            Phase::Sync => CandidateFailureStage::Sync,
            Phase::Ready => CandidateFailureStage::Closed,
        }
    }
}

/// One candidate's live connection. Retired attempts stay dead by generation
/// even if their socket or timer delivers late.
struct DialAttempt {
    candidate: RemoteCandidate,
    generation: u64,
    conn: Option<Conn>,
    phase: Phase,
    timer: Option<u32>,
    done: bool,
}

struct FirstView {
    /// Host streams whose snapshots the first view waits for.
    remaining: HashSet<Vec<u16>>,
    hello: Json,
}

const RTC_STALL_MS: u64 = 10_000;
const RTC_RETRY_MS: u64 = 50;
const UPGRADE_DELAY_MS: u64 = 1_000;
const UPGRADE_IDLE_MS: u64 = 300;
const UPGRADE_IDLE_LIMIT_MS: u64 = 30_000;
const UPGRADE_DEADLINE_MS: u64 = 25_000;
const PREPARE_RETRY_MS: u64 = 1_000;
const COOLDOWN_START_MS: u64 = 30_000;
const COOLDOWN_MAX_MS: u64 = 600_000;
const P2P_STABLE_MS: u64 = 600_000;
const FALLBACK_QUIET_MS: u64 = 60_000;
const COOLDOWN_CLEAR_INTERVAL_MS: u64 = 60_000;
const LIVENESS_INTERVAL_MS: u64 = 5_000;
const LIVENESS_BUDGET_MS: u64 = 15_000;
const LIVENESS_VERIFY_MS: u64 = 3_000;
/// A submit with no result for this long is unknown, never failed (ADR-0034 §7).
const SUBMISSION_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RtcPhase {
    Signal,
    Ice,
    Noise,
    Warm,
    Ready,
}

impl RtcPhase {
    fn as_str(self) -> &'static str {
        match self {
            RtcPhase::Signal => "signal",
            RtcPhase::Ice => "ice",
            RtcPhase::Noise => "noise",
            RtcPhase::Warm => "warm",
            RtcPhase::Ready => "active",
        }
    }
}

/// One Peer's record pump and Noise session. The core seals frames and hands
/// the carrier one record at a time; the platform reports what the library did.
struct RtcCarrier {
    peer: u32,
    phase: RtcPhase,
    handshake: Option<IkClientHandshake>,
    session: Option<SecureSession>,
    pending: VecDeque<Vec<u8>>,
    in_flight: bool,
    stall_timer: Option<u32>,
    retry_timer: Option<u32>,
    selected: Option<RtcSelectedPair>,
}

impl RtcCarrier {
    fn new(peer: u32) -> Self {
        RtcCarrier {
            peer,
            phase: RtcPhase::Signal,
            handshake: None,
            session: None,
            pending: VecDeque::new(),
            in_flight: false,
            stall_timer: None,
            retry_timer: None,
            selected: None,
        }
    }
}

struct Standby {
    carrier: RtcCarrier,
    timer: Option<u32>,
    idle_timer: Option<u32>,
    hello: Option<Json>,
    ping_call: Option<u64>,
    verify_call: Option<u64>,
    verify_timer: Option<u32>,
    signal_conn: Option<u32>,
    signal_only: bool,
    offer_call: Option<u64>,
    idle_since: Option<u64>,
}

struct Handoff {
    entries: VecDeque<(u64, OpKind, Call)>,
    standby_peer: u32,
}

/// A recorded P2P failure; `agoMs` is computed when diagnostics are read.
struct P2PFailure {
    stage: String,
    reason: String,
    at_ms: u64,
    pair: Option<RtcSelectedPair>,
}

struct SignalAttempt {
    candidates: Vec<RemoteCandidate>,
    index: usize,
    conn: Option<Conn>,
    timer: Option<u32>,
    done: bool,
}

fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}

pub struct RemoteDurable {
    source: Box<dyn CandidateSource>,
    full_candidates: Vec<RemoteCandidate>,
    candidates: Vec<RemoteCandidate>,
    mode: ConnectionMode,
    rtc: Option<RtcOptions>,
    host_rtc: Option<HostRtc>,
    signal_only_hint: bool,
    standby: Option<Standby>,
    signal_attempt: Option<SignalAttempt>,
    handoff: Option<Handoff>,
    active_rtc: Option<RtcCarrier>,
    active_path: ConnectionPath,
    p2p_failure: Option<P2PFailure>,
    next_peer: u32,
    upgrade_timer: Option<u32>,
    stable_timer: Option<u32>,
    liveness_ping_timer: Option<u32>,
    liveness_deadline_timer: Option<u32>,
    liveness_verify_timer: Option<u32>,
    /// Every outstanding probe id. Pongs can arrive out of order and more
    /// than one can be in flight at once.
    probes: HashSet<u64>,
    verify_probe: Option<u64>,
    now_ms: u64,
    cooldown_until: u64,
    no_upgrade_until: u64,
    upgrade_failures: u32,
    last_cooldown_clear: Option<u64>,
    round_candidates: Vec<RemoteCandidate>,
    candidate_index: usize,
    failures: Vec<CandidateFailure>,
    legacy_url: String,
    page_protocol: Option<String>,
    follows_host_endpoints: bool,
    host_key: String,
    pairing_endpoint_set: Option<EndpointSet>,
    /// One random suffix per session: the host keys answered peers by
    /// `device + attempt`, and a restarted app must not receive the cached
    /// answer for a previous session's offer (its mid would not match).
    rtc_attempt_nonce: u64,
    timeouts: CandidateTimeouts,
    round_timeout_ms: Option<u64>,
    round: u64,
    round_active: bool,
    round_expired: bool,
    ever_ready: bool,
    outage_noticed: bool,
    generation: u64,
    dial: Option<DialAttempt>,
    round_timer: Option<u32>,
    reconnect_remaining: Option<HashSet<Vec<u16>>>,
    /// A reconnect's shell is visible, but calls wait for its conversation and
    /// doc snapshots before entering a ciphertext FIFO.
    sync_gate: bool,
    sync_queue: VecDeque<(u64, OpKind, Call)>,
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
    /// This connection's hello has arrived. A subscribe must wait for it:
    /// the last connection's minor says nothing about this host, and the
    /// hello's wanted loop sends the right form with the new minor.
    hello_received: bool,
    host_minor: u32,
    /// Monotonic count of times the shown conversation's streams became
    /// fresh. A boolean is not enough: the platform may coalesce the hello
    /// snapshot (false) and the resubscribed snapshot (true) into one, and
    /// the UI still needs a new value to trigger ref retries.
    conversation_fresh_epoch: u64,
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
    logical_submissions: bool,
    submissions: Vec<SubmissionRecord>,
    submission_by_request: HashMap<String, usize>,
    op_submissions: HashMap<u64, usize>,
    /// A timed-out submit's call id, kept so a late result still reconciles.
    late_submission_calls: HashMap<u64, usize>,
    submission_queries: HashMap<u64, SubmissionQuery>,
    submission_timers: HashMap<u32, usize>,
    submission_recovery: VecDeque<usize>,
    recovering_submissions: bool,
    recovery_waiting: Option<u64>,
    stream_versions: HashMap<Vec<u16>, u64>,
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
        let (reconnect_min_ms, reconnect_max_ms) = options
            .reconnect_delay_ms
            .unwrap_or((DEFAULT_RECONNECT_MIN_MS, DEFAULT_RECONNECT_MAX_MS));
        let request_id = options
            .request_id
            .unwrap_or_else(|| Box::new(default_request_id));
        let follows_host_endpoints = options.mode == RemoteMode::Planned;
        let legacy_url = options
            .legacy_url
            .clone()
            .or_else(|| {
                options
                    .candidates
                    .first()
                    .map(|candidate| candidate.url.clone())
            })
            .unwrap_or_default();
        // A planned round's empty list means the host published no remote
        // entry; it must not be refilled from the legacy URL. Single mode is
        // the only one that derives its one carrier from that URL.
        let candidates = if follows_host_endpoints {
            options.candidates
        } else {
            candidate_plan(&legacy_url, None, options.page_protocol.as_deref())
        };
        let mode = options.connection_mode;
        let signal_only_hint = options.rtc.as_ref().is_some_and(|rtc| rtc.signal_only_hint);
        let full_candidates = candidates.clone();
        let filtered = filter_candidates_for_mode(&candidates, mode);
        let mut this = RemoteDurable {
            source: options.source,
            full_candidates,
            candidates: filtered,
            mode,
            rtc: options.rtc,
            host_rtc: None,
            signal_only_hint,
            standby: None,
            signal_attempt: None,
            handoff: None,
            active_rtc: None,
            active_path: ConnectionPath::Loopback,
            p2p_failure: None,
            next_peer: 0,
            upgrade_timer: None,
            stable_timer: None,
            liveness_ping_timer: None,
            liveness_deadline_timer: None,
            liveness_verify_timer: None,
            probes: HashSet::new(),
            verify_probe: None,
            now_ms: 0,
            cooldown_until: 0,
            no_upgrade_until: 0,
            upgrade_failures: 0,
            last_cooldown_clear: None,
            round_candidates: Vec::new(),
            candidate_index: 0,
            failures: Vec::new(),
            legacy_url,
            page_protocol: options.page_protocol,
            follows_host_endpoints,
            host_key: options.host_key,
            pairing_endpoint_set: options.pairing_endpoint_set,
            rtc_attempt_nonce: {
                let mut bytes = [0u8; 8];
                getrandom::fill(&mut bytes).expect("system random source");
                u64::from_le_bytes(bytes)
            },
            timeouts: options.candidate_timeouts,
            round_timeout_ms: options.round_timeout_ms,
            round: 0,
            round_active: false,
            round_expired: false,
            ever_ready: false,
            outage_noticed: false,
            generation: 0,
            dial: None,
            round_timer: None,
            reconnect_remaining: None,
            sync_gate: false,
            sync_queue: VecDeque::new(),
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
            hello_received: false,
            host_minor: 0,
            conversation_fresh_epoch: 0,
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
            logical_submissions: options.logical_submissions,
            submissions: Vec::new(),
            submission_by_request: HashMap::new(),
            op_submissions: HashMap::new(),
            late_submission_calls: HashMap::new(),
            submission_queries: HashMap::new(),
            submission_timers: HashMap::new(),
            submission_recovery: VecDeque::new(),
            recovering_submissions: false,
            recovery_waiting: None,
            stream_versions: HashMap::new(),
            first_view: None,
            ready_sent: false,
            view_dirty: false,
            request_id,
            version: 0,
            out: Vec::new(),
        };
        this.begin_round();
        this
    }

    /// Commands queued outside handle() — the constructor's first
    /// OpenConnection waits here for the platform to pick up.
    pub fn take(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.out)
    }

    /// The current view — absent until Ready(Connected).
    pub fn view(&self) -> Option<Json> {
        self.state
            .as_ref()
            .map(|state| Json::Object(Arc::new(state.clone())))
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

    /// Whether the shown conversation's own stream has sent a snapshot on
    /// the current connection. False between a reconnect hello and the
    /// resubscribed stream's fresh value, which is exactly when a ref lookup
    /// would not resolve yet.
    pub fn conversation_is_fresh(&self) -> bool {
        self.current.is_some_and(|id| {
            self.conversation_streams(id)
                .iter()
                .filter(|stream| self.wanted.contains(*stream))
                .all(|stream| self.fresh.contains(stream))
        })
    }

    /// How many times the shown conversation's streams have become fresh.
    /// The UI retries failed refs when this changes; it does not need to
    /// observe the false state, which snapshot coalescing may drop.
    pub fn conversation_fresh_epoch(&self) -> u64 {
        self.conversation_fresh_epoch
    }

    pub fn handle(&mut self, event: Event) -> Vec<Command> {
        self.view_dirty = false;
        match event {
            Event::SocketOpened { conn } => {
                if self.signal_conn_is(conn) {
                    self.signal_opened(conn);
                } else if self.live_conn(conn) {
                    // The socket opened: Noise starts now. Outcomes below may
                    // advance straight to hello in a test harness, so arm
                    // this before draining rather than overwriting them.
                    self.arm_phase(Phase::Noise, self.timeouts.noise_ms);
                    let mut conn_out = Vec::new();
                    if let Some(conn) = self.conn_mut() {
                        conn.inner.opened(&mut conn_out);
                    }
                    self.drain_conn_out(conn_out);
                }
            }
            Event::SocketData { conn, bytes } => {
                if self.signal_conn_is(conn) {
                    self.signal_data(conn, &bytes);
                } else if self.live_conn(conn) {
                    let mut conn_out = Vec::new();
                    if let Some(conn) = self.conn_mut() {
                        conn.inner.data(&bytes, &mut conn_out);
                    }
                    self.drain_conn_out(conn_out);
                }
            }
            Event::SocketClosed { conn, code, reason } => {
                if self.signal_conn_is(conn) {
                    self.signal_socket_closed(conn, code, reason);
                } else if self.live_conn(conn) {
                    let mut conn_out = Vec::new();
                    if let Some(conn) = self.conn_mut() {
                        conn.inner.closed(code, reason.clone(), &mut conn_out);
                    }
                    self.drain_conn_out(conn_out);
                    if self.live_conn(conn) {
                        let stage = self
                            .dial
                            .as_ref()
                            .map(|dial| dial.phase.stage())
                            .unwrap_or(CandidateFailureStage::Closed);
                        self.fail_current(stage, Some(code), reason);
                    }
                }
            }
            Event::SendFailed { conn } => {
                if self.signal_conn_is(conn) {
                    self.signal_socket_closed(conn, 1006, None);
                } else if self.live_conn(conn) {
                    // A write failure means the socket is broken — tell the
                    // platform to close it, then treat it as an abnormal
                    // close so pending calls fail and the round moves on.
                    self.out.push(Command::CloseSocket { conn });
                    let stage = self
                        .dial
                        .as_ref()
                        .map(|dial| dial.phase.stage())
                        .unwrap_or(CandidateFailureStage::Closed);
                    self.fail_current(stage, Some(1006), None);
                }
            }
            Event::TimerFired { timer } => self.timer_fired(timer),
            Event::Invoke { op, call } => self.invoke(op, call),
            Event::Close => self.close(),
            Event::Foreground => self.enter_foreground(),
            Event::NetworkChanged => self.network_changed(),
            Event::Background => self.enter_background(),
            Event::Clock { now_ms } => self.now_ms = now_ms,
            Event::RtcPeerReady { peer, sdp } => self.rtc_peer_ready(peer, sdp),
            Event::RtcChannelOpened { peer } => self.rtc_channel_opened(peer),
            Event::RtcData { peer, bytes } => self.rtc_data(peer, &bytes),
            Event::RtcSendResult { peer, outcome } => self.rtc_send_result(peer, outcome),
            Event::RtcLowWater { peer } => self.rtc_low_water(peer),
            Event::RtcClosed { peer, reason } => self.rtc_closed(peer, reason),
            Event::RtcSelectedCandidate { peer, local, remote } => self.rtc_selected(peer, local, remote),
            Event::SetConnectionMode { mode } => self.set_connection_mode(mode),
        }
        if self.view_dirty {
            self.version += 1;
            self.out.push(Command::ViewChanged);
        }
        std::mem::take(&mut self.out)
    }

    fn timer_fired(&mut self, timer: u32) {
        if self.closed {
            return;
        }
        if let Some(index) = self.submission_timers.remove(&timer) {
            if self.submissions[index].phase == SubmissionPhase::InFlight
                && !self.submissions[index].admitted
            {
                self.submissions[index].phase = SubmissionPhase::Unknown;
                self.submissions[index].timer = None;
                let _ = self.refresh();
                // The caller's op resolves now; a queued command may run while
                // the original submit is still outstanding.
                self.retire_submission_op(index);
            }
            return;
        }
        if self.reconnect_timer == Some(timer) {
            self.reconnect_timer = None;
            self.begin_round();
            return;
        }
        if self.upgrade_timer == Some(timer) {
            self.upgrade_timer = None;
            self.maybe_start_upgrade();
            return;
        }
        if self.stable_timer == Some(timer) {
            self.stable_timer = None;
            if self.active_rtc.is_some() && self.dial.as_ref().is_some_and(|dial| dial.phase == Phase::Ready) {
                self.upgrade_failures = 0;
                self.cooldown_until = 0;
                self.no_upgrade_until = 0;
            }
            return;
        }
        if self.liveness_ping_timer == Some(timer) {
            self.liveness_ping_timer = None;
            self.liveness_tick();
            return;
        }
        if self.liveness_deadline_timer == Some(timer) {
            self.liveness_deadline_timer = None;
            self.fallback_from_p2p("no pong within 15000ms");
            return;
        }
        if self.liveness_verify_timer == Some(timer) {
            self.liveness_verify_timer = None;
            if let Some(id) = self.verify_probe.take() {
                self.probes.remove(&id);
            }
            self.fallback_from_p2p("the foreground verification ping did not answer within 3000ms");
            return;
        }
        if self.standby_timer_fired(timer)
            || self.signal_timer_fired(timer)
            || self.rtc_stall_fired(timer)
            || self.rtc_retry_fired(timer)
        {
            return;
        }
        if self.round_timer == Some(timer) {
            self.round_timer = None;
            if !self.round_active {
                return;
            }
            self.round_expired = true;
            if let Some(dial) = &self.dial {
                let candidate = dial.candidate.clone();
                let budget = self.round_budget();
                self.record_failure(
                    candidate,
                    CandidateFailureStage::Round,
                    false,
                    None,
                    Some(format!("the connection round exceeded {budget}ms")),
                );
            }
            self.abandon_dial();
            self.round_failed();
            return;
        }
        let Some(dial) = &self.dial else { return };
        if dial.timer != Some(timer) {
            return;
        }
        let phase = dial.phase;
        let ms = self.timeout_for(phase);
        if let Some(dial) = &mut self.dial {
            dial.timer = None;
        }
        self.fail_current(
            phase.stage(),
            None,
            Some(format!("no progress within {ms}ms")),
        );
    }

    fn timeout_for(&self, phase: Phase) -> u64 {
        match phase {
            Phase::Open => self.timeouts.socket_open_ms,
            Phase::Noise => self.timeouts.noise_ms,
            Phase::Hello => self.timeouts.hello_ms,
            Phase::Sync | Phase::Ready => self.timeouts.sync_ms,
        }
    }

    /// A pending backoff is cut short; a network change also restarts a round
    /// that is still dialling. A live ready connection is never re-dialled by
    /// an interface change.
    fn reconnect_now(&mut self, force: bool) {
        if self.closed {
            return;
        }
        if self.dial.as_ref().map(|dial| dial.phase) == Some(Phase::Ready) {
            return;
        }
        let had_backoff = self.reconnect_timer.take();
        if let Some(timer) = had_backoff {
            self.attempt = 0;
            self.out.push(Command::CancelReconnect { timer });
        } else if !force {
            return;
        }
        if force && self.dial.is_some() {
            self.clear_round_timer();
            self.abandon_dial();
        }
        if !self.round_active || self.dial.is_none() {
            self.attempt = 0;
            self.begin_round();
        }
    }

    fn conn(&self) -> Option<&Conn> {
        self.dial.as_ref()?.conn.as_ref()
    }

    fn conn_mut(&mut self) -> Option<&mut Conn> {
        self.dial.as_mut()?.conn.as_mut()
    }

    fn live_conn(&self, conn: u32) -> bool {
        self.dial
            .as_ref()
            .is_some_and(|dial| dial.generation == self.generation && !dial.done)
            && self.conn().map(|c| c.id) == Some(conn)
    }

    fn live_dial(&self, conn: u32, generation: u64) -> bool {
        self.dial.as_ref().is_some_and(|dial| {
            !dial.done
                && dial.generation == generation
                && dial.generation == self.generation
                && dial.conn.as_ref().map(|c| c.id) == Some(conn)
        })
    }

    // ─── Candidate rounds ───────────────────────────────────────────────

    fn begin_round(&mut self) {
        if self.closed || self.dial.is_some() {
            return;
        }
        self.clear_round_timer();
        self.clear_backoff();
        self.round += 1;
        self.round_candidates = self.candidates.clone();
        self.candidate_index = 0;
        self.failures.clear();
        self.round_expired = false;
        self.round_active = true;
        let budget = self.round_budget();
        let timer = self.next_timer;
        self.next_timer += 1;
        self.round_timer = Some(timer);
        self.out.push(Command::ScheduleDeadline {
            timer,
            delay_ms: budget,
        });
        self.open_candidate();
    }

    fn round_budget(&self) -> u64 {
        let per_candidate = self.timeouts.socket_open_ms
            + self.timeouts.noise_ms
            + self.timeouts.hello_ms
            + self.timeouts.sync_ms;
        self.round_timeout_ms
            .unwrap_or(self.round_candidates.len() as u64 * per_candidate + 1_000)
    }

    fn open_candidate(&mut self) {
        loop {
            if self.closed || !self.round_active || self.dial.is_some() {
                return;
            }
            if self.round_expired {
                self.round_failed();
                return;
            }
            let Some(candidate) = self.round_candidates.get(self.candidate_index).cloned() else {
                self.round_failed();
                return;
            };
            self.candidate_index += 1;
            if let Some(reason) = candidate.unsupported.clone() {
                self.record_failure(
                    candidate,
                    CandidateFailureStage::Unsupported,
                    false,
                    None,
                    Some(reason),
                );
                continue;
            }
            self.hello_received = false;
            self.next_conn += 1;
            let id = self.next_conn;
            self.generation += 1;
            let generation = self.generation;
            let inner = self.source.open(&candidate);
            self.dial = Some(DialAttempt {
                candidate: candidate.clone(),
                generation,
                conn: Some(Conn { id, inner }),
                phase: Phase::Open,
                timer: None,
                done: false,
            });
            self.out.push(Command::OpenConnection {
                conn: id,
                url: candidate.url,
            });
            self.arm_phase(Phase::Open, self.timeouts.socket_open_ms);
            return;
        }
    }

    fn arm_phase(&mut self, phase: Phase, ms: u64) {
        if self.dial.is_none() || self.closed {
            return;
        }
        self.clear_dial_timer();
        let timer = self.next_timer;
        self.next_timer += 1;
        if let Some(dial) = &mut self.dial {
            dial.phase = phase;
            dial.timer = Some(timer);
        }
        self.out.push(Command::ScheduleDeadline {
            timer,
            delay_ms: ms,
        });
    }

    // ─── RTC standby, handoff, liveness and modes ───────────────────────

    fn schedule_upgrade(&mut self, delay_ms: u64) {
        if self.closed || self.rtc.is_none() || self.mode == ConnectionMode::RelayOnly {
            return;
        }
        self.clear_upgrade_timer();
        let timer = self.next_timer;
        self.next_timer += 1;
        self.upgrade_timer = Some(timer);
        self.out.push(Command::ScheduleDeadline { timer, delay_ms });
    }

    fn clear_upgrade_timer(&mut self) {
        let Some(timer) = self.upgrade_timer.take() else { return };
        self.out.push(Command::CancelDeadline { timer });
    }

    fn maybe_start_upgrade(&mut self) {
        if self.closed || self.rtc.is_none() || self.mode == ConnectionMode::RelayOnly {
            return;
        }
        if self.standby.is_some() || self.handoff.is_some() || self.signal_attempt.is_some() {
            return;
        }
        let blocked_until = self.cooldown_until.max(self.no_upgrade_until);
        if self.now_ms < blocked_until {
            self.schedule_upgrade(blocked_until - self.now_ms);
            return;
        }
        if let Some(dial) = &self.dial {
            if dial.phase == Phase::Ready && self.state.as_ref().is_some_and(|state| {
                state
                    .get(&key("connection"))
                    .and_then(Json::as_str)
                    .is_some_and(|s| s.to_string_lossy() == CONNECTED)
            }) {
                if self.active_path == ConnectionPath::P2p {
                    return;
                }
                let host_rtc = self.host_rtc.clone();
                if host_rtc.is_some() && dial.conn.is_some() {
                    let signal_conn = dial.conn.as_ref().map(|conn| conn.id);
                    if let Some(signal_conn) = signal_conn {
                        self.start_standby(signal_conn, false);
                    }
                }
                return;
            }
        }
        if self.mode != ConnectionMode::DirectOnly {
            return;
        }
        if self.host_rtc.is_none() && !self.signal_only_hint {
            return;
        }
        self.open_signal_attempt();
    }

    fn start_standby(&mut self, signal_conn: u32, signal_only: bool) {
        if self.rtc.is_none() || self.standby.is_some() || self.closed {
            return;
        }
        self.next_peer += 1;
        let peer = self.next_peer;
        let mut standby = Standby {
            carrier: RtcCarrier::new(peer),
            timer: None,
            idle_timer: None,
            hello: None,
            ping_call: None,
            verify_call: None,
            verify_timer: None,
            signal_conn: Some(signal_conn),
            signal_only,
            offer_call: None,
            idle_since: None,
        };
        let timer = self.next_timer;
        self.next_timer += 1;
        standby.timer = Some(timer);
        self.out.push(Command::ScheduleDeadline { timer, delay_ms: UPGRADE_DEADLINE_MS });
        let stun = self.host_rtc.as_ref().map(|rtc| rtc.stun.clone()).unwrap_or_default();
        self.out.push(Command::CreateRtcPeer { peer, stun });
        self.p2p_failure = None;
        self.standby = Some(standby);
    }

    fn rtc_carrier(&self, peer: u32) -> Option<&RtcCarrier> {
        if let Some(standby) = self.standby.as_ref().filter(|s| s.carrier.peer == peer) {
            return Some(&standby.carrier);
        }
        self.active_rtc.as_ref().filter(|carrier| carrier.peer == peer)
    }

    fn rtc_carrier_mut(&mut self, peer: u32) -> Option<&mut RtcCarrier> {
        if let Some(standby) = self.standby.as_mut().filter(|s| s.carrier.peer == peer) {
            return Some(&mut standby.carrier);
        }
        self.active_rtc.as_mut().filter(|carrier| carrier.peer == peer)
    }

    fn rtc_enqueue(&mut self, peer: u32, records: Vec<Vec<u8>>) {
        let Some(carrier) = self.rtc_carrier_mut(peer) else { return };
        carrier.pending.extend(records);
        self.rtc_reset_stall(peer);
        self.rtc_pump(peer);
    }

    fn rtc_reset_stall(&mut self, peer: u32) {
        let old = self.rtc_carrier_mut(peer).and_then(|carrier| carrier.stall_timer.take());
        if let Some(timer) = old {
            self.out.push(Command::CancelDeadline { timer });
        }
        let has_pending = self.rtc_carrier(peer).is_some_and(|carrier| !carrier.pending.is_empty());
        if !has_pending {
            return;
        }
        let timer = self.next_timer;
        self.next_timer += 1;
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            carrier.stall_timer = Some(timer);
        }
        self.out.push(Command::ScheduleDeadline { timer, delay_ms: RTC_STALL_MS });
    }

    fn rtc_pump(&mut self, peer: u32) {
        let mut send = None;
        let mut clear_stall = None;
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            // A rejected record waits for low water or the bounded retry;
            // pumping it again from the outcome callback would busy-loop.
            if carrier.retry_timer.is_none() && !carrier.in_flight && !carrier.pending.is_empty() {
                send = carrier.pending.front().cloned();
                carrier.in_flight = send.is_some();
            }
            if carrier.pending.is_empty() {
                clear_stall = carrier.stall_timer.take();
            }
        }
        if let Some(timer) = clear_stall {
            self.out.push(Command::CancelDeadline { timer });
        }
        if let Some(bytes) = send {
            self.out.push(Command::RtcSend { peer, bytes });
        }
    }

    fn rtc_schedule_retry(&mut self, peer: u32) {
        let old = self.rtc_carrier_mut(peer).and_then(|carrier| carrier.retry_timer.take());
        if let Some(timer) = old {
            self.out.push(Command::CancelDeadline { timer });
        }
        let timer = self.next_timer;
        self.next_timer += 1;
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            carrier.retry_timer = Some(timer);
        }
        self.out.push(Command::ScheduleDeadline {
            timer,
            delay_ms: RTC_RETRY_MS,
        });
    }

    fn rtc_cancel_retry(&mut self, peer: u32) {
        let timer = self.rtc_carrier_mut(peer).and_then(|carrier| carrier.retry_timer.take());
        if let Some(timer) = timer {
            self.out.push(Command::CancelDeadline { timer });
        }
    }

    fn rtc_retry_fired(&mut self, timer: u32) -> bool {
        let peer = self
            .standby
            .as_ref()
            .filter(|s| s.carrier.retry_timer == Some(timer))
            .map(|s| s.carrier.peer)
            .or_else(|| {
                self.active_rtc
                    .as_ref()
                    .filter(|c| c.retry_timer == Some(timer))
                    .map(|c| c.peer)
            });
        let Some(peer) = peer else { return false };
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            carrier.retry_timer = None;
        }
        self.rtc_pump(peer);
        true
    }

    fn rtc_send_text(&mut self, peer: u32, text: String) -> Result<(), String> {
        let Some(carrier) = self.rtc_carrier_mut(peer) else {
            return Err("the RTC carrier is gone".to_string());
        };
        let Some(session) = carrier.session.as_mut() else {
            return Err("the RTC carrier is not authenticated".to_string());
        };
        let records = session.seal(&text).map_err(|error| error.to_string())?;
        self.rtc_enqueue(peer, records);
        Ok(())
    }

    fn rtc_stall_fired(&mut self, timer: u32) -> bool {
        let peer = self
            .standby
            .as_ref()
            .filter(|s| s.carrier.stall_timer == Some(timer))
            .map(|s| s.carrier.peer)
            .or_else(|| {
                self.active_rtc
                    .as_ref()
                    .filter(|c| c.stall_timer == Some(timer))
                    .map(|c| c.peer)
            });
        let Some(peer) = peer else { return false };
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            carrier.stall_timer = None;
        }
        self.rtc_fail(peer, "the DataChannel made no progress for 10000ms");
        true
    }

    fn rtc_fail(&mut self, peer: u32, reason: &str) {
        if self.standby.as_ref().is_some_and(|s| s.carrier.peer == peer) {
            self.fail_standby(peer, reason);
        } else if self.active_rtc.as_ref().is_some_and(|c| c.peer == peer) {
            // The reference records a lost carrier as "liveness" once the
            // dial is ready, and as "commit" while the handoff sync barrier
            // is still closed.
            match self.dial.as_ref().map(|dial| dial.phase) {
                Some(Phase::Ready) | None => self.fallback_from_p2p(reason),
                Some(phase) => self.fail_current(phase.stage(), Some(1006), Some(reason.to_string())),
            }
        }
    }

    fn rtc_peer_ready(&mut self, peer: u32, sdp: String) {
        let Some(standby) = self.standby.as_mut().filter(|s| s.carrier.peer == peer) else {
            self.out.push(Command::CloseRtcPeer { peer });
            return;
        };
        if standby.carrier.phase != RtcPhase::Signal {
            return;
        }
        let Some(signal_conn) = standby.signal_conn else {
            self.fail_standby(peer, "the signal connection is gone");
            return;
        };
        let id = self.next_call;
        self.next_call += 1;
        if let Some(standby) = self.standby.as_mut() {
            standby.offer_call = Some(id);
        }
        let attempt = format!("rtc-{:016x}-{peer}", self.rtc_attempt_nonce);
        let mut args = JsonObject::new();
        set(&mut args, "attempt", Json::from(attempt));
        set(&mut args, "sdp", Json::from(sdp));
        let text = encode_client_frame(&ClientFrame::Call {
            id: id as f64,
            method: U16String::from_str("rtcOffer"),
            args: Json::Object(Arc::new(args)),
        });
        if !self.send_on_conn(signal_conn, text) {
            self.fail_standby(peer, "the signal connection is gone");
        }
    }

    fn send_on_conn(&mut self, conn_id: u32, text: String) -> bool {
        if self.dial.as_ref().and_then(|d| d.conn.as_ref()).map(|c| c.id) == Some(conn_id) {
            let mut out = Vec::new();
            if let Some(conn) = self.conn_mut() {
                conn.inner.send(text, &mut out);
            }
            self.drain_conn_out(out);
            return true;
        }
        if self
            .signal_attempt
            .as_ref()
            .and_then(|attempt| attempt.conn.as_ref())
            .map(|conn| conn.id)
            == Some(conn_id)
        {
            let mut out = Vec::new();
            if let Some(attempt) = self.signal_attempt.as_mut() {
                if let Some(conn) = attempt.conn.as_mut() {
                    conn.inner.send(text, &mut out);
                }
            }
            self.drain_signal_out(conn_id, out);
            return true;
        }
        false
    }

    fn handle_rtc_result(&mut self, call_id: u64, ok: bool, value: Json, error: Json) -> bool {
        let Some(standby) = self.standby.as_mut() else { return false };
        if standby.offer_call == Some(call_id) {
            standby.offer_call = None;
            if !ok {
                let reason = U16String::js_string(&error).to_string_lossy();
                let peer = standby.carrier.peer;
                self.fail_standby(peer, &reason);
                return true;
            }
            let peer = standby.carrier.peer;
            let Some(sdp) = value.get("sdp").and_then(Json::as_str).map(|s| s.to_string_lossy()) else {
                self.fail_standby(peer, "the host returned a malformed rtcOffer answer");
                return true;
            };
            match parse_rtc_max_message_size(&sdp) {
                RtcMaxMessageSize::Invalid(reason) => {
                    self.fail_standby(peer, &reason);
                    return true;
                }
                _ => {}
            }
            if let Some(standby) = self.standby.as_mut() {
                standby.carrier.phase = RtcPhase::Ice;
            }
            self.out.push(Command::AcceptRtcAnswer { peer, sdp });
            return true;
        }
        if standby.verify_call == Some(call_id) {
            standby.verify_call = None;
            if let Some(timer) = standby.verify_timer.take() {
                self.out.push(Command::CancelDeadline { timer });
            }
            if ok {
                self.install_standby();
            } else {
                let reason = U16String::js_string(&error).to_string_lossy();
                self.release_to_old(&reason);
            }
            return true;
        }
        if standby.ping_call == Some(call_id) {
            standby.ping_call = None;
            let peer = standby.carrier.peer;
            if !ok {
                self.fail_standby(peer, "the warm ping failed");
                return true;
            }
            self.standby_warm(peer);
            return true;
        }
        false
    }

    fn rtc_channel_opened(&mut self, peer: u32) {
        let Some((device, host_key)) = self.rtc.as_ref().and_then(RtcOptions::keys) else {
            self.rtc_fail(peer, "the RTC key material is unusable");
            return;
        };
        let Some(carrier) = self.rtc_carrier_mut(peer) else { return };
        let Ok(handshake) = initiate_handshake_with_prologue(&device, host_key, None, SECURE_PROLOGUE) else {
            self.rtc_fail(peer, "Noise IK could not start");
            return;
        };
        let message = handshake.message1().to_vec();
        carrier.handshake = Some(handshake);
        carrier.phase = RtcPhase::Noise;
        self.rtc_enqueue(peer, vec![message]);
    }

    fn rtc_data(&mut self, peer: u32, bytes: &[u8]) {
        enum Routed {
            None,
            Standby(String),
            Active(String),
            Failed(String),
        }
        let mut routed = Routed::None;
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            if carrier.session.is_none() {
                let Some(handshake) = carrier.handshake.take() else {
                    carrier.phase = RtcPhase::Noise;
                    return;
                };
                match handshake.read_message2(bytes) {
                    Ok((_hello, session, _hash)) => {
                        carrier.session = Some(session);
                        carrier.phase = RtcPhase::Noise;
                    }
                    Err(error) => {
                        routed = Routed::Failed(error.to_string());
                    }
                }
            } else if let Some(session) = carrier.session.as_mut() {
                match session.open(bytes) {
                    Ok(Some(text)) => {
                        if self.standby.as_ref().is_some_and(|s| s.carrier.peer == peer) {
                            routed = Routed::Standby(text);
                        } else {
                            routed = Routed::Active(text);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => routed = Routed::Failed(error.to_string()),
                }
            }
        }
        match routed {
            Routed::Standby(text) => self.standby_receive_text(peer, &text),
            Routed::Active(text) => self.receive_text(&text),
            Routed::Failed(reason) => self.rtc_fail(peer, &reason),
            Routed::None => {}
        }
    }

    fn rtc_send_result(&mut self, peer: u32, outcome: RtcSendOutcome) {
        let mut reset_stall = false;
        let mut rejected = false;
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            carrier.in_flight = false;
            if outcome == RtcSendOutcome::Rejected {
                rejected = true;
            } else {
                carrier.pending.pop_front();
                reset_stall = true;
            }
        }
        if rejected {
            // The library did not take the record. Retry the same ciphertext
            // only on low water or after a bounded delay.
            self.rtc_schedule_retry(peer);
            return;
        }
        self.rtc_cancel_retry(peer);
        if reset_stall {
            self.rtc_reset_stall(peer);
        }
        self.rtc_pump(peer);
    }

    fn rtc_low_water(&mut self, peer: u32) {
        self.rtc_cancel_retry(peer);
        self.rtc_pump(peer);
    }

    fn rtc_selected(&mut self, peer: u32, local: RtcCandidateInfo, remote: RtcCandidateInfo) {
        if let Some(carrier) = self.rtc_carrier_mut(peer) {
            carrier.selected = Some(rtc_selected_pair(&local, &remote));
        }
    }

    fn rtc_closed(&mut self, peer: u32, reason: Option<String>) {
        // Keep the platform's reason as-is: RtcClosed also reports failures
        // that are not DataChannel closes (a Peer that never gathered a
        // candidate, for one). The TypeScript carrier adds its own prefix.
        self.rtc_fail(peer, reason.as_deref().unwrap_or("the DataChannel closed"));
    }

    fn standby_receive_text(&mut self, peer: u32, text: &str) {
        let Ok(frame) = Json::parse(text) else {
            self.fail_standby(peer, "the DataChannel sent a frame that is not JSON");
            return;
        };
        if frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() == Some("hello") {
            let Some(standby) = self.standby.as_mut().filter(|s| s.carrier.peer == peer) else {
                return;
            };
            standby.hello = Some(frame);
            if standby.ping_call.is_none() {
                let id = self.next_call;
                self.next_call += 1;
                if let Some(standby) = self.standby.as_mut() {
                    standby.ping_call = Some(id);
                }
                let mut args = JsonObject::new();
                set(&mut args, "id", Json::from(format!("warm-{id}")));
                let call = encode_client_frame(&ClientFrame::Call {
                    id: id as f64,
                    method: U16String::from_str("ping"),
                    args: Json::Object(Arc::new(args)),
                });
                if let Err(error) = self.rtc_send_text(peer, call) {
                    self.fail_standby(peer, &error);
                }
            }
            return;
        }
        if frame.get("type").and_then(Json::as_str).map(|s| s.to_string_lossy()).as_deref() == Some("result") {
            let Some(id) = frame
                .get("id")
                .and_then(Json::as_number)
                .filter(|v| v.fract() == 0.0 && *v >= 0.0)
                .map(|v| v as u64)
            else {
                return;
            };
            let ok = frame.get("ok").is_some_and(Json::truthy);
            let value = frame.get("value").cloned().unwrap_or(Json::Null);
            let error = frame.get("error").cloned().unwrap_or(Json::Null);
            self.handle_rtc_result(id, ok, value, error);
        }
    }

    fn standby_warm(&mut self, peer: u32) {
        let active_ready = self.dial.as_ref().is_some_and(|dial| dial.phase == Phase::Ready);
        let Some(standby) = self.standby.as_mut().filter(|s| s.carrier.peer == peer) else {
            return;
        };
        standby.carrier.phase = RtcPhase::Warm;
        if let Some(timer) = standby.timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        let timer = self.next_timer;
        self.next_timer += 1;
        standby.timer = Some(timer);
        self.out.push(Command::ScheduleDeadline { timer, delay_ms: UPGRADE_IDLE_LIMIT_MS });
        if !active_ready {
            self.start_handoff();
            return;
        }
        self.schedule_standby_poll(peer, 0);
    }

    fn schedule_standby_poll(&mut self, peer: u32, delay_ms: u64) {
        let Some(standby) = self.standby.as_mut().filter(|s| s.carrier.peer == peer) else {
            return;
        };
        if let Some(timer) = standby.idle_timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        let timer = self.next_timer;
        self.next_timer += 1;
        standby.idle_timer = Some(timer);
        self.out.push(Command::ScheduleDeadline { timer, delay_ms });
    }

    fn standby_poll(&mut self, peer: u32) {
        let active_ready = self.dial.as_ref().is_some_and(|dial| dial.phase == Phase::Ready);
        if !active_ready {
            self.start_handoff();
            return;
        }
        let busy = !self.pending_calls.is_empty()
            || self.active.iter().any(|op| matches!(op.waiting, Some(Wait::Snapshots(_))));
        let Some(standby) = self.standby.as_mut().filter(|s| s.carrier.peer == peer) else {
            return;
        };
        if busy {
            standby.idle_since = None;
            self.schedule_standby_poll(peer, 100);
            return;
        }
        let now = self.now_ms;
        match standby.idle_since {
            None => {
                standby.idle_since = Some(now);
                self.schedule_standby_poll(peer, 100);
            }
            Some(since) if now.saturating_sub(since) < UPGRADE_IDLE_MS => {
                self.schedule_standby_poll(peer, 100);
            }
            Some(_) => {
                if let Some(timer) = standby.idle_timer.take() {
                    self.out.push(Command::CancelDeadline { timer });
                }
                self.start_handoff();
            }
        }
    }

    fn standby_timer_fired(&mut self, timer: u32) -> bool {
        let Some(peer) = self.standby.as_ref().map(|s| s.carrier.peer) else {
            return false;
        };
        let phase = self.standby.as_ref().map(|s| s.carrier.phase);
        let mut matched = false;
        if let Some(standby) = self.standby.as_mut() {
            if standby.timer == Some(timer) {
                standby.timer = None;
                matched = true;
            } else if standby.idle_timer == Some(timer) {
                standby.idle_timer = None;
                self.standby_poll(peer);
                return true;
            } else if standby.verify_timer == Some(timer) {
                standby.verify_timer = None;
                standby.verify_call = None;
                self.release_to_old("the RTC preverify ping did not answer within 3000ms");
                return true;
            }
        }
        if !matched {
            return false;
        }
        if phase == Some(RtcPhase::Warm) {
            self.defer_standby(peer, "no idle window within 30000ms");
        } else {
            self.fail_standby(peer, "WebRTC preparation exceeded 25000ms");
        }
        true
    }

    fn signal_timer_fired(&mut self, timer: u32) -> bool {
        let Some(attempt) = self.signal_attempt.as_mut() else {
            return false;
        };
        if attempt.timer != Some(timer) {
            return false;
        }
        attempt.timer = None;
        attempt.done = true;
        if let Some(conn) = attempt.conn.take() {
            self.out.push(Command::CloseSocket { conn: conn.id });
        }
        attempt.done = false;
        self.signal_next_candidate();
        true
    }

    fn drain_signal_out(&mut self, conn_id: u32, outcomes: Vec<ConnOut>) {
        for outcome in outcomes {
            if self
                .signal_attempt
                .as_ref()
                .and_then(|attempt| attempt.conn.as_ref())
                .map(|conn| conn.id)
                != Some(conn_id)
            {
                return;
            }
            match outcome {
                ConnOut::SendBytes(bytes) => self.out.push(Command::SendBytes { conn: conn_id, bytes }),
                ConnOut::Close => self.out.push(Command::CloseSocket { conn: conn_id }),
                ConnOut::Text(text) => self.signal_receive_text(conn_id, &text),
                ConnOut::Closed { code, reason } => {
                    self.signal_closed(conn_id, code, reason);
                    return;
                }
                ConnOut::Authenticated { paired: _ } => {}
            }
        }
    }

    fn signal_receive_text(&mut self, conn_id: u32, text: &str) {
        let Ok(frame) = Json::parse(text) else { return };
        let frame_type = frame
            .get("type")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .unwrap_or_default();
        if frame_type == "result" {
            let Some(id) = frame
                .get("id")
                .and_then(Json::as_number)
                .filter(|v| v.fract() == 0.0 && *v >= 0.0)
                .map(|v| v as u64)
            else {
                return;
            };
            let ok = frame.get("ok").is_some_and(Json::truthy);
            let value = frame.get("value").cloned().unwrap_or(Json::Null);
            let error = frame.get("error").cloned().unwrap_or(Json::Null);
            self.handle_rtc_result(id, ok, value, error);
            return;
        }
        if frame_type != "signalHello" {
            return;
        }
        match parse_host_rtc(&frame) {
            Ok(Some(rtc)) => {
                self.host_rtc = Some(rtc);
                if !self.signal_only_hint {
                    self.signal_only_hint = true;
                    self.out.push(Command::RtcSignalOnly {
                        host_key: self.host_key.clone(),
                        signal_only: true,
                    });
                }
                if let Some(attempt) = self.signal_attempt.as_mut() {
                    attempt.done = true;
                    if let Some(timer) = attempt.timer.take() {
                        self.out.push(Command::CancelDeadline { timer });
                    }
                }
                self.start_standby(conn_id, true);
            }
            Ok(None) => self.direct_unavailable("the host did not advertise WebRTC on its signal connection"),
            Err(error) => self.direct_unavailable(&error),
        }
    }

    fn signal_closed(&mut self, conn_id: u32, _code: u16, _reason: Option<String>) {
        if let Some(standby) = self.standby.as_ref() {
            if standby.signal_only && standby.signal_conn == Some(conn_id) {
                let peer = standby.carrier.peer;
                let phase = standby.carrier.phase;
                if phase != RtcPhase::Noise && phase != RtcPhase::Warm {
                    self.fail_standby(peer, "the signal-only connection closed");
                }
                return;
            }
        }
        if self.signal_conn_is(conn_id) {
            self.signal_next_candidate();
        }
    }

    fn start_handoff(&mut self) {
        if self.handoff.is_some() {
            return;
        }
        let Some(peer) = self.standby.as_ref().map(|s| s.carrier.peer) else {
            return;
        };
        if self.standby.as_ref().is_none_or(|s| s.hello.is_none()) {
            return;
        }
        self.handoff = Some(Handoff {
            entries: VecDeque::new(),
            standby_peer: peer,
        });
        let active_ready = self.dial.as_ref().is_some_and(|dial| dial.phase == Phase::Ready);
        if !active_ready {
            self.install_standby();
            return;
        }
        let id = self.next_call;
        self.next_call += 1;
        let timer = self.next_timer;
        self.next_timer += 1;
        if let Some(standby) = self.standby.as_mut() {
            standby.verify_call = Some(id);
            standby.verify_timer = Some(timer);
        }
        self.out.push(Command::ScheduleDeadline { timer, delay_ms: LIVENESS_VERIFY_MS });
        let mut args = JsonObject::new();
        set(&mut args, "id", Json::from(format!("preverify-{id}")));
        let call = encode_client_frame(&ClientFrame::Call {
            id: id as f64,
            method: U16String::from_str("ping"),
            args: Json::Object(Arc::new(args)),
        });
        if let Err(error) = self.rtc_send_text(peer, call) {
            self.release_to_old(&error);
        }
    }

    fn install_standby(&mut self) {
        let Some(mut standby) = self.standby.take() else { return };
        let Some(hello) = standby.hello.take() else {
            self.out.push(Command::CloseRtcPeer { peer: standby.carrier.peer });
            self.handoff = None;
            return;
        };
        if let Some(mut old) = self.dial.take() {
            old.done = true;
            if let Some(timer) = old.timer.take() {
                self.out.push(Command::CancelDeadline { timer });
            }
            if let Some(conn) = old.conn.take() {
                self.out.push(Command::CloseSocket { conn: conn.id });
            }
        }
        if standby.signal_only {
            self.close_signal_attempt();
        }
        for timer in [
            standby.timer.take(),
            standby.idle_timer.take(),
            standby.verify_timer.take(),
        ]
        .into_iter()
        .flatten()
        {
            self.out.push(Command::CancelDeadline { timer });
        }
        self.generation += 1;
        standby.carrier.phase = RtcPhase::Ready;
        self.active_path = ConnectionPath::P2p;
        self.active_rtc = Some(standby.carrier);
        self.dial = Some(DialAttempt {
            candidate: RemoteCandidate {
                url: "webrtc".to_string(),
                role: RemoteCandidateRole::Direct,
                unsupported: None,
            },
            generation: self.generation,
            conn: None,
            phase: Phase::Sync,
            timer: None,
            done: false,
        });
        if let Err(error) = self.receive_hello(hello) {
            self.fail_channel(&error);
        }
    }

    fn release_to_old(&mut self, reason: &str) {
        let Some(handoff) = self.handoff.take() else { return };
        let pair = self
            .standby
            .as_ref()
            .and_then(|standby| standby.carrier.selected.clone());
        if let Some(standby) = self.standby.take() {
            self.clear_standby_timers(&standby);
            self.out.push(Command::CloseRtcPeer { peer: standby.carrier.peer });
            if standby.signal_only {
                self.close_signal_attempt();
            }
        }
        self.record_p2p_failure("commit", reason, pair);
        self.preparation_failed();
        for (op, kind, call) in handoff.entries {
            self.invoke(op, call);
            let _ = kind;
        }
        self.schedule_upgrade(self.cooldown_remaining());
    }

    fn abort_handoff(&mut self, error: &str) {
        let Some(handoff) = self.handoff.take() else { return };
        if let Some(standby) = self.standby.take() {
            self.clear_standby_timers(&standby);
            self.out.push(Command::CloseRtcPeer { peer: standby.carrier.peer });
            if standby.signal_only {
                self.close_signal_attempt();
            }
        }
        if let Some(carrier) = self.active_rtc.take() {
            self.out.push(Command::CloseRtcPeer { peer: carrier.peer });
        }
        self.clear_liveness();
        for (op, kind, _call) in handoff.entries {
            // Nothing was sent on a carrier yet; the host definitely did not
            // see these.
            self.finish_failed(op, kind, error, None);
        }
    }

    fn finish_handoff(&mut self) {
        let Some(handoff) = self.handoff.take() else { return };
        if self.standby.is_some() {
            return;
        }
        for (op, _kind, call) in handoff.entries {
            self.invoke(op, call);
        }
        self.start_stable_timer();
    }

    fn clear_standby_timers(&mut self, standby: &Standby) {
        for timer in [
            standby.timer,
            standby.idle_timer,
            standby.verify_timer,
            standby.carrier.stall_timer,
            standby.carrier.retry_timer,
        ]
        .into_iter()
        .flatten()
        {
            self.out.push(Command::CancelDeadline { timer });
        }
    }

    fn fail_standby(&mut self, peer: u32, reason: &str) {
        if self.handoff.as_ref().is_some_and(|h| h.standby_peer == peer) {
            self.release_to_old(reason);
            return;
        }
        let Some(standby) = self.standby.take().filter(|s| s.carrier.peer == peer) else {
            return;
        };
        self.clear_standby_timers(&standby);
        self.out.push(Command::CloseRtcPeer { peer });
        if standby.signal_only {
            // The standby's signal connection is the signal attempt's conn;
            // close_signal_attempt closes it, exactly once.
            self.close_signal_attempt();
        }
        let stage = match standby.carrier.phase {
            RtcPhase::Signal => "signal",
            RtcPhase::Ice => "ice",
            RtcPhase::Noise => "noise",
            RtcPhase::Warm | RtcPhase::Ready => "warm",
        };
        self.record_p2p_failure(stage, reason, standby.carrier.selected.clone());
        if standby.signal_only && stage == "signal" {
            self.signal_only_hint = false;
            self.out.push(Command::RtcSignalOnly {
                host_key: self.host_key.clone(),
                signal_only: false,
            });
        }
        self.preparation_failed();
        if self.state.is_none() && self.mode == ConnectionMode::DirectOnly && self.dial.is_none() {
            self.direct_unavailable(reason);
            return;
        }
        self.schedule_upgrade(self.cooldown_remaining());
    }

    fn defer_standby(&mut self, peer: u32, reason: &str) {
        let Some(standby) = self.standby.take().filter(|s| s.carrier.peer == peer) else {
            return;
        };
        self.clear_standby_timers(&standby);
        self.out.push(Command::CloseRtcPeer { peer });
        if standby.signal_only {
            self.close_signal_attempt();
        }
        self.record_p2p_failure("commit", reason, standby.carrier.selected.clone());
        self.schedule_upgrade(PREPARE_RETRY_MS);
    }

    fn record_p2p_failure(&mut self, stage: &str, reason: &str, pair: Option<RtcSelectedPair>) {
        self.p2p_failure = Some(P2PFailure {
            stage: stage.to_string(),
            reason: reason.to_string(),
            at_ms: self.now_ms,
            pair,
        });
    }

    fn preparation_failed(&mut self) {
        self.upgrade_failures = self.upgrade_failures.saturating_add(1);
        let exponent = self.upgrade_failures.saturating_sub(1).min(8);
        let delay = COOLDOWN_START_MS
            .saturating_mul(1u64 << exponent)
            .min(COOLDOWN_MAX_MS);
        self.cooldown_until = self.now_ms.saturating_add(delay);
    }

    fn cooldown_remaining(&self) -> u64 {
        self.cooldown_until
            .max(self.no_upgrade_until)
            .saturating_sub(self.now_ms)
    }

    fn clear_cooldown(&mut self) {
        self.upgrade_failures = 0;
        self.cooldown_until = 0;
        self.no_upgrade_until = 0;
    }

    fn start_stable_timer(&mut self) {
        if let Some(timer) = self.stable_timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        let timer = self.next_timer;
        self.next_timer += 1;
        self.stable_timer = Some(timer);
        self.out.push(Command::ScheduleDeadline { timer, delay_ms: P2P_STABLE_MS });
    }

    fn start_liveness(&mut self) {
        self.clear_liveness();
        if self.active_rtc.is_none() || self.dial.as_ref().map(|dial| dial.phase) != Some(Phase::Ready) {
            return;
        }
        let ping = self.next_timer;
        self.next_timer += 1;
        self.liveness_ping_timer = Some(ping);
        self.out.push(Command::ScheduleDeadline {
            timer: ping,
            delay_ms: LIVENESS_INTERVAL_MS,
        });
        self.reset_liveness_deadline();
    }

    fn reset_liveness_deadline(&mut self) {
        if let Some(timer) = self.liveness_deadline_timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        let timer = self.next_timer;
        self.next_timer += 1;
        self.liveness_deadline_timer = Some(timer);
        self.out.push(Command::ScheduleDeadline {
            timer,
            delay_ms: LIVENESS_BUDGET_MS,
        });
    }

    fn clear_liveness(&mut self) {
        for timer in [self.liveness_ping_timer.take(), self.liveness_deadline_timer.take(), self.liveness_verify_timer.take()]
            .into_iter()
            .flatten()
        {
            self.out.push(Command::CancelDeadline { timer });
        }
        self.probes.clear();
        self.verify_probe = None;
    }

    fn liveness_tick(&mut self) {
        if self.active_rtc.is_none() || self.dial.as_ref().map(|dial| dial.phase) != Some(Phase::Ready) {
            return;
        }
        self.send_probe(false);
        let timer = self.next_timer;
        self.next_timer += 1;
        self.liveness_ping_timer = Some(timer);
        self.out.push(Command::ScheduleDeadline {
            timer,
            delay_ms: LIVENESS_INTERVAL_MS,
        });
    }

    fn send_probe(&mut self, verify: bool) {
        let Some(peer) = self.active_rtc.as_ref().map(|carrier| carrier.peer) else { return };
        let id = self.next_call;
        self.next_call += 1;
        self.probes.insert(id);
        if verify {
            self.verify_probe = Some(id);
            let timer = self.next_timer;
            self.next_timer += 1;
            self.liveness_verify_timer = Some(timer);
            self.out.push(Command::ScheduleDeadline {
                timer,
                delay_ms: LIVENESS_VERIFY_MS,
            });
        }
        let mut args = JsonObject::new();
        set(&mut args, "id", Json::from(format!("probe-{id}")));
        let call = encode_client_frame(&ClientFrame::Call {
            id: id as f64,
            method: U16String::from_str("ping"),
            args: Json::Object(Arc::new(args)),
        });
        if let Err(error) = self.rtc_send_text(peer, call) {
            self.fallback_from_p2p(&error);
        }
    }

    fn fallback_from_p2p(&mut self, reason: &str) {
        if self.active_rtc.is_none() && self.handoff.is_none() && self.standby.is_none() {
            return;
        }
        // A close during the handoff sync must fail the barrier's queued ops
        // before the next round starts, never leave them parked forever.
        if self.handoff.is_some() {
            self.abort_handoff("Disconnected from host");
        }
        let pair = self
            .active_rtc
            .as_ref()
            .and_then(|carrier| carrier.selected.clone());
        self.close_rtc_objects();
        self.record_p2p_failure("liveness", reason, pair);
        self.no_upgrade_until = self.now_ms.saturating_add(FALLBACK_QUIET_MS);
        self.clear_liveness();
        if let Some(timer) = self.stable_timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        if let Some(mut dial) = self.dial.take() {
            dial.done = true;
            if let Some(timer) = dial.timer.take() {
                self.out.push(Command::CancelDeadline { timer });
            }
        }
        self.reject_pending_calls();
        self.set_field("connection", Json::from(RECONNECTING));
        self.begin_round();
    }

    fn enter_background(&mut self) {
        self.clear_liveness();
    }

    fn enter_foreground(&mut self) {
        if self.active_rtc.is_some() && self.dial.as_ref().map(|dial| dial.phase) == Some(Phase::Ready) {
            self.clear_liveness();
            self.send_probe(true);
            return;
        }
        self.reconnect_now(false);
    }

    fn network_changed(&mut self) {
        let should_clear = self
            .last_cooldown_clear
            .is_none_or(|last| self.now_ms.saturating_sub(last) >= COOLDOWN_CLEAR_INTERVAL_MS);
        if should_clear {
            self.last_cooldown_clear = Some(self.now_ms);
            self.clear_cooldown();
        }
        if self.active_rtc.is_some() && self.dial.as_ref().map(|dial| dial.phase) == Some(Phase::Ready) {
            self.clear_liveness();
            self.send_probe(true);
            return;
        }
        self.reconnect_now(true);
    }

    fn set_connection_mode(&mut self, mode: ConnectionMode) {
        if mode == self.mode {
            return;
        }
        self.mode = mode;
        self.candidates = filter_candidates_for_mode(&self.full_candidates, mode);
        self.clear_upgrade_timer();
        self.clear_liveness();
        if let Some(timer) = self.stable_timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        self.abort_handoff("Disconnected from host");
        if let Some(standby) = self.standby.take() {
            self.clear_standby_timers(&standby);
            self.out.push(Command::CloseRtcPeer { peer: standby.carrier.peer });
            if standby.signal_only {
                self.close_signal_attempt();
            }
        }
        if let Some(carrier) = self.active_rtc.take() {
            self.out.push(Command::CloseRtcPeer { peer: carrier.peer });
        }
        if let Some(attempt) = self.signal_attempt.take() {
            if let Some(timer) = attempt.timer {
                self.out.push(Command::CancelDeadline { timer });
            }
            if let Some(conn) = attempt.conn {
                self.out.push(Command::CloseSocket { conn: conn.id });
            }
        }
        if self.closed {
            return;
        }
        self.clear_round_timer();
        self.clear_backoff();
        self.abandon_dial();
        self.reject_pending_calls();
        if self.state.is_some() {
            self.set_field("connection", Json::from(RECONNECTING));
        }
        self.begin_round();
    }

    fn direct_unavailable(&mut self, reason: &str) {
        if self.closed {
            return;
        }
        if self.state.is_none() {
            self.closed = true;
            self.clear_all_timers();
            self.ready_sent = true;
            self.out.push(Command::Ready {
                outcome: ReadyOutcome::DirectUnavailable {
                    reason: reason.to_string(),
                },
            });
            return;
        }
        self.notice(
            Json::from("error"),
            Json::from(format!("{DIRECT_UNAVAILABLE} ({reason})")),
        );
        self.set_field("connection", Json::from(RECONNECTING));
        self.schedule_backoff();
    }

    fn open_signal_attempt(&mut self) {
        if self.rtc.is_none() || self.signal_attempt.is_some() || self.closed {
            return;
        }
        let Some(attempts) = self.signal_attempt_candidates() else {
            return;
        };
        if attempts.is_empty() {
            self.direct_unavailable("no relay candidate is available for signaling");
            return;
        }
        self.signal_attempt = Some(SignalAttempt {
            candidates: attempts,
            index: 0,
            conn: None,
            timer: None,
            done: false,
        });
        self.signal_next_candidate();
    }

    fn signal_attempt_candidates(&self) -> Option<Vec<RemoteCandidate>> {
        Some(signal_candidates(&self.full_candidates))
    }

    fn signal_next_candidate(&mut self) {
        if let Some(timer) = self.signal_attempt.as_mut().and_then(|attempt| attempt.timer.take()) {
            self.out.push(Command::CancelDeadline { timer });
        }
        loop {
            let Some(attempt) = self.signal_attempt.as_mut() else { return };
            if attempt.done || self.closed {
                return;
            }
            let Some(candidate) = attempt.candidates.get(attempt.index).cloned() else {
                let shutdown = self.signal_attempt.take();
                if let Some(attempt) = shutdown {
                    if let Some(timer) = attempt.timer {
                        self.out.push(Command::CancelDeadline { timer });
                    }
                    if let Some(conn) = attempt.conn {
                        self.out.push(Command::CloseSocket { conn: conn.id });
                    }
                }
                self.direct_unavailable("every relay signal path failed");
                return;
            };
            attempt.index += 1;
            if candidate.unsupported.is_some() {
                continue;
            }
            let inner = self.source.open_signal(&candidate);
            self.next_conn += 1;
            let conn_id = self.next_conn;
            let conn = Conn { id: conn_id, inner };
            let timer = self.next_timer;
            self.next_timer += 1;
            if let Some(attempt) = self.signal_attempt.as_mut() {
                attempt.conn = Some(conn);
                attempt.timer = Some(timer);
            }
            self.out.push(Command::OpenConnection {
                conn: conn_id,
                url: candidate.url,
            });
            self.out.push(Command::ScheduleDeadline {
                timer,
                delay_ms: self.timeouts.socket_open_ms + self.timeouts.noise_ms + self.timeouts.hello_ms,
            });
            return;
        }
    }

    fn close_signal_attempt(&mut self) {
        let Some(attempt) = self.signal_attempt.take() else { return };
        if let Some(timer) = attempt.timer {
            self.out.push(Command::CancelDeadline { timer });
        }
        if let Some(conn) = attempt.conn {
            self.out.push(Command::CloseSocket { conn: conn.id });
        }
    }

    fn signal_conn_is(&self, conn: u32) -> bool {
        self.signal_attempt
            .as_ref()
            .and_then(|attempt| attempt.conn.as_ref())
            .map(|c| c.id)
            == Some(conn)
    }

    fn signal_opened(&mut self, conn: u32) {
        let mut out = Vec::new();
        if let Some(attempt) = self.signal_attempt.as_mut() {
            if let Some(c) = attempt.conn.as_mut().filter(|c| c.id == conn) {
                c.inner.opened(&mut out);
            }
        }
        self.drain_signal_out(conn, out);
    }

    fn signal_socket_closed(&mut self, conn: u32, code: u16, reason: Option<String>) {
        let mut out = Vec::new();
        if let Some(attempt) = self.signal_attempt.as_mut() {
            if let Some(c) = attempt.conn.as_mut().filter(|c| c.id == conn) {
                c.inner.closed(code, reason, &mut out);
            }
        }
        self.drain_signal_out(conn, out);
        self.signal_closed(conn, code, None);
    }

    fn signal_data(&mut self, conn: u32, bytes: &[u8]) {
        let mut out = Vec::new();
        if let Some(attempt) = self.signal_attempt.as_mut() {
            if let Some(c) = attempt.conn.as_mut().filter(|c| c.id == conn) {
                c.inner.data(bytes, &mut out);
            }
        }
        self.drain_signal_out(conn, out);
    }

    /// Diagnostics for the connection-mode UI (ADR-0033 §5).
    pub fn rtc_diagnostics(&self) -> Json {
        let phase = if let Some(standby) = &self.standby {
            standby.carrier.phase.as_str()
        } else if self.active_rtc.is_some() && self.dial.as_ref().map(|dial| dial.phase) == Some(Phase::Ready) {
            "active"
        } else if self.cooldown_remaining() > 0 {
            "cooldown"
        } else if self.upgrade_timer.is_some() {
            "scheduled"
        } else {
            "idle"
        };
        let mut object = JsonObject::new();
        set(&mut object, "path", Json::from(self.active_path.as_str()));
        set(&mut object, "phase", Json::from(phase));
        set(&mut object, "available", Json::Bool(self.host_rtc.is_some()));
        if let Some(failure) = &self.p2p_failure {
            let mut recorded = JsonObject::new();
            set(&mut recorded, "stage", Json::from(failure.stage.clone()));
            set(&mut recorded, "reason", Json::from(failure.reason.clone()));
            set(
                &mut recorded,
                "agoMs",
                Json::Number(self.now_ms.saturating_sub(failure.at_ms) as f64),
            );
            if let Some(pair) = &failure.pair {
                set(&mut recorded, "pair", pair.to_json());
            }
            set(&mut object, "lastFailure", Json::Object(Arc::new(recorded)));
        }
        if let Some(pair) = self
            .active_rtc
            .as_ref()
            .and_then(|carrier| carrier.selected.as_ref())
        {
            set(&mut object, "selectedPair", pair.to_json());
        }
        set(
            &mut object,
            "cooldownRemainingMs",
            Json::Number(self.cooldown_remaining() as f64),
        );
        Json::Object(Arc::new(object))
    }

    fn clear_dial_timer(&mut self) {
        let Some(timer) = self.dial.as_mut().and_then(|dial| dial.timer.take()) else {
            return;
        };
        self.out.push(Command::CancelDeadline { timer });
    }

    fn clear_round_timer(&mut self) {
        let Some(timer) = self.round_timer.take() else {
            return;
        };
        self.out.push(Command::CancelDeadline { timer });
    }

    fn clear_backoff(&mut self) {
        if let Some(timer) = self.reconnect_timer.take() {
            self.out.push(Command::CancelReconnect { timer });
        }
    }

    fn record_failure(
        &mut self,
        candidate: RemoteCandidate,
        stage: CandidateFailureStage,
        unauthorized: bool,
        code: Option<u16>,
        reason: Option<String>,
    ) {
        let failure = CandidateFailure {
            candidate,
            stage,
            unauthorized,
            code,
            reason,
        };
        self.failures.push(failure.clone());
        self.out.push(Command::CandidateFailed { failure });
    }

    fn fail_current(
        &mut self,
        stage: CandidateFailureStage,
        code: Option<u16>,
        reason: Option<String>,
    ) {
        let Some(dial) = &self.dial else { return };
        if self.closed || dial.done {
            return;
        }
        let candidate = dial.candidate.clone();
        let was_ready = dial.phase == Phase::Ready;
        self.record_failure(
            candidate,
            stage,
            code == Some(UNAUTHORIZED_CLOSE_CODE),
            code,
            reason.clone(),
        );
        self.abandon_dial();
        self.reject_pending_calls();
        if self.closed {
            return;
        }
        if self.active_rtc.is_some() {
            if was_ready {
                self.fallback_from_p2p(reason.as_deref().unwrap_or("the DataChannel closed"));
                return;
            }
            let pair = self
                .active_rtc
                .as_ref()
                .and_then(|carrier| carrier.selected.clone());
            self.record_p2p_failure("commit", reason.as_deref().unwrap_or("the DataChannel closed"), pair);
            self.abort_handoff("Disconnected from host");
            if let Some(carrier) = self.active_rtc.take() {
                self.out.push(Command::CloseRtcPeer { peer: carrier.peer });
            }
            self.set_field("connection", Json::from(RECONNECTING));
            self.begin_round();
            return;
        }
        if was_ready {
            self.set_field("connection", Json::from(RECONNECTING));
            self.begin_round();
            return;
        }
        if self.round_expired {
            self.round_failed();
            return;
        }
        self.open_candidate();
    }

    /// Stop the current dial without recording a failure or starting the next
    /// one. Its socket and deadline are retired; late events find no live
    /// connection.
    fn abandon_dial(&mut self) {
        let Some(mut dial) = self.dial.take() else {
            return;
        };
        dial.done = true;
        self.fail_submission_queries();
        if self.sync_gate || !self.sync_queue.is_empty() {
            self.sync_gate = false;
            let queued = std::mem::take(&mut self.sync_queue);
            for (op, kind, _call) in queued {
                self.finish_failed(op, kind, "Disconnected from host", None);
            }
        }
        if let Some(timer) = dial.timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        if let Some(conn) = dial.conn.take() {
            self.out.push(Command::CloseSocket { conn: conn.id });
        }
    }

    /// A lost carrier also loses the reconciliation/queries riding it. A
    /// retry that had not settled becomes unknown; an admitted record keeps
    /// its fact and waits for the next snapshot or reconnect.
    fn fail_submission_queries(&mut self) {
        let queries = std::mem::take(&mut self.submission_queries);
        let mut mark_unknown = Vec::new();
        for query in queries.values() {
            match query {
                SubmissionQuery::RetryQuery(index, op)
                | SubmissionQuery::RetryResend(index, op) => {
                    mark_unknown.push(*index);
                    self.out.push(Command::OperationSucceeded {
                        op: *op,
                        value: None,
                    });
                }
                SubmissionQuery::TakeBackQuery(_, op)
                | SubmissionQuery::TakeBackWithdraw(_, op) => {
                    self.out.push(Command::OperationSucceeded {
                        op: *op,
                        value: None,
                    });
                }
                SubmissionQuery::RecoveryQuery(_)
                | SubmissionQuery::RecoveryResend(_)
                | SubmissionQuery::Confirm(_) => {}
            }
        }
        for index in mark_unknown {
            if self.submissions[index].phase != SubmissionPhase::Settled {
                self.submissions[index].phase = SubmissionPhase::Unknown;
                self.clear_submission_timer(index);
            }
        }
        self.recovering_submissions = false;
        self.recovery_waiting = None;
        self.submission_recovery.clear();
    }

    fn reject_pending_calls(&mut self) {
        let pending: Vec<u64> = self.pending_calls.drain().map(|(_, op)| op).collect();
        for op_id in pending {
            if let Some(index) = self.active.iter().position(|op| op.op_id == op_id) {
                self.fail_op(index, "Disconnected from host");
            }
        }
    }

    fn dialed_failures(&self) -> Vec<&CandidateFailure> {
        self.failures
            .iter()
            .filter(|failure| failure.stage != CandidateFailureStage::Unsupported)
            .collect()
    }

    fn unauthorized_round(&self) -> bool {
        let dialed = self.dialed_failures();
        !dialed.is_empty() && dialed.iter().all(|failure| failure.unauthorized)
    }

    fn aggregate_message(&self) -> String {
        if self.unauthorized_round() {
            return "Unauthorized: this client is not allowed (wrong token, or the device is not paired or was revoked)"
                .to_string();
        }
        let details = self
            .failures
            .iter()
            .map(describe_failure)
            .collect::<Vec<_>>()
            .join("; ");
        if details.is_empty() {
            REMOTE_ACCESS_UNAVAILABLE.to_string()
        } else {
            format!("Could not connect to the host: {details}")
        }
    }

    fn round_failed(&mut self) {
        if !self.round_active {
            return;
        }
        self.round_active = false;
        self.clear_round_timer();
        self.clear_backoff();
        self.abandon_dial();
        if self.closed {
            return;
        }
        let dialed = self.dialed_failures().len();
        let unauthorized = self.unauthorized_round();
        let empty_plan = self.round_candidates.is_empty();
        if !unauthorized
            && self.mode == ConnectionMode::DirectOnly
            && self.rtc.is_some()
            && (self.signal_only_hint || self.host_rtc.is_some())
            && self.signal_attempt.is_none()
            && self.standby.is_none()
            && self.dial.is_none()
        {
            self.open_signal_attempt();
            return;
        }
        if !self.ever_ready {
            self.closed = true;
            self.clear_all_timers();
            self.ready_sent = true;
            let outcome = if unauthorized {
                ReadyOutcome::Unauthorized
            } else if empty_plan {
                ReadyOutcome::Error(REMOTE_ACCESS_UNAVAILABLE.to_string())
            } else {
                ReadyOutcome::Error(self.aggregate_message())
            };
            self.out.push(Command::Ready { outcome });
            return;
        }
        if unauthorized {
            self.closed = true;
            self.clear_all_timers();
            self.set_field("connection", Json::from(CLOSED));
            self.set_field("unauthorized", Json::Bool(true));
            self.notice(
                Json::from("error"),
                Json::from("Unauthorized: this client is not allowed (wrong token, or the device is not paired or was revoked)"),
            );
            return;
        }
        if dialed == 0 {
            self.closed = true;
            self.clear_all_timers();
            self.set_field("connection", Json::from(CLOSED));
            let message = if empty_plan {
                REMOTE_ACCESS_UNAVAILABLE.to_string()
            } else {
                self.aggregate_message()
            };
            self.notice(Json::from("error"), Json::from(message));
            return;
        }
        self.set_field("connection", Json::from(RECONNECTING));
        if !self.outage_noticed {
            self.outage_noticed = true;
            let message = self.aggregate_message();
            self.notice(Json::from("error"), Json::from(message));
        }
        self.schedule_backoff();
    }

    fn schedule_backoff(&mut self) {
        self.clear_backoff();
        let delay = self
            .reconnect_min_ms
            .saturating_mul(2u64.saturating_pow(self.attempt))
            .min(self.reconnect_max_ms);
        self.attempt = self.attempt.saturating_add(1);
        let timer = self.next_timer;
        self.next_timer += 1;
        self.reconnect_timer = Some(timer);
        self.out.push(Command::ScheduleReconnect {
            timer,
            delay_ms: delay,
        });
    }

    fn clear_all_timers(&mut self) {
        let submission_timers: Vec<u32> = self.submission_timers.keys().copied().collect();
        for timer in submission_timers {
            self.out.push(Command::CancelDeadline { timer });
        }
        self.submission_timers.clear();
        for record in &mut self.submissions {
            record.timer = None;
        }
        self.clear_round_timer();
        self.clear_backoff();
        self.clear_dial_timer();
        self.clear_upgrade_timer();
        if let Some(timer) = self.stable_timer.take() {
            self.out.push(Command::CancelDeadline { timer });
        }
        self.clear_liveness();
        if let Some(standby) = &self.standby {
            let mut timers = vec![
                standby.timer,
                standby.idle_timer,
                standby.verify_timer,
            ];
            for timer in timers.drain(..).flatten() {
                self.out.push(Command::CancelDeadline { timer });
            }
        }
        if let Some(timer) = self.signal_attempt.as_ref().and_then(|attempt| attempt.timer) {
            self.out.push(Command::CancelDeadline { timer });
        }
        let mut carrier_timers = Vec::new();
        if let Some(standby) = &mut self.standby {
            carrier_timers.push(standby.carrier.stall_timer.take());
            carrier_timers.push(standby.carrier.retry_timer.take());
        }
        if let Some(carrier) = &mut self.active_rtc {
            carrier_timers.push(carrier.stall_timer.take());
            carrier_timers.push(carrier.retry_timer.take());
        }
        for timer in carrier_timers.into_iter().flatten() {
            self.out.push(Command::CancelDeadline { timer });
        }
    }

    fn close_rtc_objects(&mut self) {
        if let Some(standby) = self.standby.take() {
            self.clear_standby_timers(&standby);
            self.out.push(Command::CloseRtcPeer {
                peer: standby.carrier.peer,
            });
            if standby.signal_only {
                self.close_signal_attempt();
            }
        }
        self.close_signal_attempt();
        if let Some(carrier) = self.active_rtc.take() {
            self.out.push(Command::CloseRtcPeer { peer: carrier.peer });
        }
        self.clear_liveness();
    }

    fn fail_sync_queue(&mut self, error: &str) {
        if self.sync_gate || !self.sync_queue.is_empty() {
            self.sync_gate = false;
            let queued = std::mem::take(&mut self.sync_queue);
            for (op, kind, _call) in queued {
                self.finish_failed(op, kind, error, None);
            }
        }
    }

    /// Translate one connection's outcomes into commands and state changes.
    fn drain_conn_out(&mut self, outcomes: Vec<ConnOut>) {
        // Capture the source once. A malformed frame can retire this dial and
        // install the next candidate mid-batch; the rest of the batch still
        // belongs to the old socket and must be dropped, never applied to its
        // successor by re-reading `self.conn()`.
        let Some((source_id, source_generation)) = self
            .dial
            .as_ref()
            .and_then(|dial| dial.conn.as_ref().map(|conn| (conn.id, dial.generation)))
        else {
            return;
        };
        for outcome in outcomes {
            if !self.live_dial(source_id, source_generation) {
                return;
            }
            match outcome {
                ConnOut::SendBytes(bytes) => {
                    self.out.push(Command::SendBytes { conn: source_id, bytes })
                }
                ConnOut::Close => self.out.push(Command::CloseSocket { conn: source_id }),
                ConnOut::Text(text) => self.receive_text(&text),
                ConnOut::Closed { code, reason } => {
                    let stage = self
                        .dial
                        .as_ref()
                        .map(|dial| dial.phase.stage())
                        .unwrap_or(CandidateFailureStage::Closed);
                    self.fail_current(stage, Some(code), reason);
                }
                ConnOut::Authenticated { paired } => {
                    self.arm_phase(Phase::Hello, self.timeouts.hello_ms);
                    if paired {
                        self.paired();
                    }
                }
            }
            if !self.live_dial(source_id, source_generation) {
                return;
            }
        }
    }

    fn paired(&mut self) {
        let endpoint_set = self.pairing_endpoint_set.clone();
        if let Some(details) = self.source.mark_paired() {
            // The stored legacy URL is the invite's preferred path (relay
            // first), not whichever candidate happened to verify message 2;
            // old clients cannot use the endpoint set.
            let url = match &endpoint_set {
                Some(set) => preferred_legacy_url(&self.legacy_url, set),
                None if !self.legacy_url.is_empty() => self.legacy_url.clone(),
                None => details.0,
            };
            self.out.push(Command::Paired {
                url,
                host_key: details.1,
                private_key: details.2,
                endpoint_set,
            });
        }
    }

    /// `#send` — a text frame through the live connection (queues inside a
    /// secure connection that is still handshaking, like the reference).
    fn set_bound_skills(&self, args: &mut JsonObject, skills: &Option<Vec<String>>) {
        if let Some(skills) = skills {
            if host_supports_feature(self.host_minor, HostFeature::BoundSkills) {
                set(
                    args,
                    "skills",
                    Json::array(skills.iter().map(|name| Json::from(name.clone())).collect()),
                );
            }
        }
    }

    fn send(&mut self, frame: ClientFrame) {
        let text = encode_client_frame(&frame);
        if let Some(peer) = self.active_rtc.as_ref().map(|carrier| carrier.peer) {
            if let Err(error) = self.rtc_send_text(peer, text) {
                self.fallback_from_p2p(&error);
            }
            return;
        }
        if let Some(conn) = self.conn_mut() {
            let mut conn_out = Vec::new();
            conn.inner.send(text, &mut conn_out);
            self.drain_conn_out(conn_out);
        }
    }

    /// Subscribe to one stream. Conversation streams ask a 5.15 host for
    /// refs on every (re)subscribe; the minor is read here, never cached,
    /// because a reconnect may land on another host version (ADR-0027).
    fn subscribe_stream(&mut self, stream: Vec<u16>) {
        // Before the hello the minor is unknown; the hello's #wanted loop
        // sends this stream with the right form once it has read it.
        if !self.hello_received {
            return;
        }
        let images = host_supports_feature(self.host_minor, HostFeature::ImageRefs)
            && U16String(stream.clone())
                .to_string_lossy()
                .starts_with("conversation:");
        self.send(ClientFrame::Subscribe {
            stream: U16String(stream),
            images,
        });
    }

    /// `#receive` — one complete JSON text frame; errors are candidate
    /// failures like a JSON.parse/apply exception inside the transport.
    fn receive_text(&mut self, text: &str) {
        let parsed = match Json::parse(text) {
            Ok(parsed) => parsed,
            Err(error) => {
                return self
                    .fail_channel(&format!("the host sent a frame that is not JSON: {error}"));
            }
        };
        let frame = classify_server_frame(parsed);
        let result = match frame {
            ServerFrame::Hello(value) => self.receive_hello(value),
            ServerFrame::Snapshot { stream, value } => self.receive_snapshot(stream, value),
            ServerFrame::Ops { stream, ops } => self.receive_ops(stream, ops),
            ServerFrame::Ended { stream, reason } => self.receive_ended(stream, reason),
            ServerFrame::Result {
                id,
                ok,
                value,
                error,
            } => {
                self.receive_result(id, ok, value, error);
                Ok(())
            }
            ServerFrame::Notice { level, message } => {
                self.notice(level, message);
                Ok(())
            }
            // A signal-only hello belongs to a connection this client never
            // opens; ignoring it keeps a future host frame forward-compatible.
            ServerFrame::SignalHello(_) => Ok(()),
            ServerFrame::Ignored => Ok(()),
        };
        if let Err(error) = result {
            self.fail_channel(&error);
        }
    }

    /// A secure-channel or frame failure retires this candidate only; the
    /// round decides whether another path gets a turn.
    fn fail_channel(&mut self, message: &str) {
        let stage = self
            .dial
            .as_ref()
            .map(|dial| dial.phase.stage())
            .unwrap_or(CandidateFailureStage::Closed);
        self.fail_current(
            stage,
            Some(1008),
            Some(format!("Secure channel failed: {message}")),
        );
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
            let direction = if host_major > PROTOCOL.major as f64 {
                "client-older"
            } else {
                "host-older"
            };
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
                set(
                    &mut mismatch,
                    "clientMajor",
                    Json::Number(PROTOCOL.major as f64),
                );
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
            // A hello authenticated by this channel is a host-wide verdict:
            // no other path would speak a different major (ADR-0032 §6).
            self.closed = true;
            self.clear_all_timers();
            self.abandon_dial();
            return Ok(());
        }
        let host_minor = match &announced {
            Json::Object(object) => minor_version(object.get(&key("minor")))?,
            // A number-typed `protocol` (the legacy form) declares no minor.
            _ => 0,
        };
        self.host_minor = host_minor;
        self.host_rtc = parse_host_rtc(&frame)?;
        if self.host_rtc.as_ref().is_some_and(|rtc| rtc.signal_only) && !self.signal_only_hint {
            self.signal_only_hint = true;
            if self.rtc.is_some() {
                self.out.push(Command::RtcSignalOnly {
                    host_key: self.host_key.clone(),
                    signal_only: true,
                });
            }
        }
        self.hello_received = true;
        self.clear_dial_timer();
        if let Some(dial) = &mut self.dial {
            dial.phase = Phase::Sync;
            dial.timer = None;
        }
        self.arm_phase(Phase::Sync, self.timeouts.sync_ms);
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
            self.subscribe_stream(stream);
        }
        if let Some(value) = frame.get("endpointSet") {
            if let ParsedEndpointSet::Valid(set) = parse_endpoint_set(Some(value)) {
                if self.follows_host_endpoints {
                    self.full_candidates =
                        candidate_plan(&self.legacy_url, Some(&set), self.page_protocol.as_deref());
                    self.candidates = filter_candidates_for_mode(&self.full_candidates, self.mode);
                }
                let url = preferred_legacy_url(&self.legacy_url, &set);
                self.out.push(Command::EndpointSet {
                    host_key: self.host_key.clone(),
                    url,
                    endpoint_set: set,
                });
            }
        }
        let mut remaining: HashSet<Vec<u16>> = host_streams(host_minor)
            .into_iter()
            .map(|name| key(name))
            .filter(|stream| !self.fresh.contains(stream))
            .collect();
        // A sync barrier also waits for the shown conversations and their
        // docs (ADR-0033 §3 step 8); this applies to ordinary reconnects and
        // to the P2P handoff alike.
        if let Some(id) = self.current {
            for stream in self.conversation_streams(id) {
                if !self.fresh.contains(&stream) {
                    remaining.insert(stream);
                }
            }
        }
        if let Some(id) = self.side {
            for stream in self.conversation_streams(id) {
                if !self.fresh.contains(&stream) {
                    remaining.insert(stream);
                }
            }
        }
        if self.state.is_some() {
            self.set_or_clear("session", frame.get("session").cloned());
            self.set_or_clear("toolPresentations", frame.get("toolPresentations").cloned());
            self.set_field("connection", Json::from(RECONNECTING));
            self.set_field("host", self.host_info());
            self.reconnect_remaining = Some(remaining);
            self.refresh()?;
            self.maybe_reconnect_shell();
            if self
                .reconnect_remaining
                .as_ref()
                .is_some_and(HashSet::is_empty)
            {
                self.finish_reconnect();
            }
        } else if remaining.is_empty() {
            self.first_view = Some(FirstView {
                remaining,
                hello: frame,
            });
            self.finish_first_view();
        } else {
            // First view waits for every covered host stream's snapshot.
            self.first_view = Some(FirstView {
                remaining,
                hello: frame,
            });
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
        let was_fresh = self.conversation_is_fresh();
        self.values.insert(units.clone(), value);
        self.fresh.insert(units.clone());
        *self.stream_versions.entry(units.clone()).or_insert(0) += 1;
        if !was_fresh && self.conversation_is_fresh() {
            self.conversation_fresh_epoch += 1;
        }
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
        let mut reconnect_ready = false;
        if let Some(remaining) = &mut self.reconnect_remaining {
            if remaining.remove(&units) && remaining.is_empty() {
                reconnect_ready = true;
            }
        }
        self.maybe_reconnect_shell();
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
        } else if reconnect_ready {
            self.finish_reconnect();
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
        // An ended stream satisfies a sync barrier: waiting forever would
        // leave the handoff queue stuck after the host said there is nothing
        // more (ADR-0033 §3 step 8).
        let mut first_ready = false;
        if let Some(first) = &mut self.first_view {
            if first.remaining.remove(&units) && first.remaining.is_empty() {
                first_ready = true;
            }
        }
        let mut reconnect_ready = false;
        if let Some(remaining) = &mut self.reconnect_remaining {
            if remaining.remove(&units) && remaining.is_empty() {
                reconnect_ready = true;
            }
        }
        if self.current.is_some_and(|id| self.conversation_streams(id).contains(&units)) {
            self.unshow()?;
        } else if self.side.is_some_and(|id| self.conversation_streams(id).contains(&units)) {
            self.show_side(None)?;
        }
        if first_ready {
            self.finish_first_view();
        } else if reconnect_ready {
            self.finish_reconnect();
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
        if let Some(query) = self.submission_queries.remove(&call_id) {
            self.handle_submission_query(call_id, query, ok.truthy(), value);
            return;
        }
        if self.probes.remove(&call_id) {
            let verify = self.verify_probe == Some(call_id);
            if verify {
                self.verify_probe = None;
                if let Some(timer) = self.liveness_verify_timer.take() {
                    self.out.push(Command::CancelDeadline { timer });
                }
            }
            if ok.truthy() {
                self.reset_liveness_deadline();
                if self.liveness_ping_timer.is_none() {
                    let timer = self.next_timer;
                    self.next_timer += 1;
                    self.liveness_ping_timer = Some(timer);
                    self.out.push(Command::ScheduleDeadline {
                        timer,
                        delay_ms: LIVENESS_INTERVAL_MS,
                    });
                }
            } else if verify {
                self.fallback_from_p2p("the foreground verification ping failed");
            }
            return;
        }
        let rtc_ok = ok.truthy();
        if self.handle_rtc_result(call_id, rtc_ok, value.clone(), error.clone()) {
            return;
        }
        if let Some(index) = self.late_submission_calls.remove(&call_id) {
            if ok.truthy() {
                self.finish_submission_result(index, Some(value));
            } else {
                let message = U16String::js_string(&error).to_string_lossy();
                self.mark_submission_failed(index, &message);
            }
            return;
        }
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

    /// `#close` — the app ended the session.
    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.abort_handoff("Disconnected from host");
        self.fail_sync_queue("Disconnected from host");
        self.close_rtc_objects();
        self.clear_all_timers();
        self.set_field("connection", Json::from(CLOSED));
        if let Some(dial) = self.dial.take() {
            if let Some(conn) = dial.conn {
                self.out.push(Command::CloseSocket { conn: conn.id });
            }
        }
    }

    // ─── Controller surface ─────────────────────────────────────────────

    fn invoke(&mut self, op: u64, mut call: Call) {
        if self.logical_submissions && self.handoff.is_none() && !self.sync_gate {
            match call {
                submission @ Call::Submit { .. } => {
                    self.create_submission(op, submission);
                    return;
                }
                Call::RetrySubmission { request_id } => {
                    self.retry_submission(op, &request_id);
                    return;
                }
                Call::TakeBackSubmission { request_id } => {
                    self.take_back_submission(op, &request_id);
                    return;
                }
                other => call = other,
            }
        }
        let kind = op_kind(&call);
        if let Some(handoff) = self.handoff.as_mut() {
            // The atomic barrier closed the new-call entrance; the op waits
            // here until sync releases it, so it never enters a ciphertext
            // FIFO before the handoff verdict.
            handoff.entries.push_back((op, kind, call));
            return;
        }
        if self.sync_gate {
            self.sync_queue.push_back((op, kind, call));
            return;
        }
        match kind {
            OpKind::Unqueued | OpKind::Direct => self.begin_op(op, kind, call, false),
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
        if let Some(index) = self.logical_submit_index(&call) {
            if self.begin_logical_submit(op_id, index, &call) {
                return;
            }
        }
        match self.op_steps(&call) {
            Ok(steps) => {
                self.active.push(ActiveOp {
                    op_id,
                    kind,
                    holds_queue,
                    steps,
                    waiting: None,
                    carrier: None,
                    last_result: None,
                });
                let index = self.active.len() - 1;
                self.drive(index);
            }
            Err(error) => self.finish_failed(op_id, kind, &error, None),
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
        let too_old_image_refs = || {
            "The host is too old for image refs (needs protocol 5.15); run `pinomad upgrade` on the host"
                .to_string()
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
            Call::CreateConversation { home, text, checkout, model, thinking_level, agent, images, skills, attachments } => {
                if !images.is_empty() && !host_supports_feature(self.host_minor, HostFeature::Images) {
                    return Err(too_old_images());
                }
                // A pre-5.15 host calls `{ ref }` malformed and closes with
                // 4400; bytes still reach a 5.5 host (ADR-0018 §2).
                if has_image_ref(images) && !host_supports_feature(self.host_minor, HostFeature::ImageRefs) {
                    return Err(too_old_image_refs());
                }
                check_attachments(self.host_minor, attachments)?;
                // A pre-5.10 host would silently ignore `agent` and create an
                // unassigned conversation — fail instead (ADR-0023 §8).
                if agent.is_some() && !host_supports_feature(self.host_minor, HostFeature::AgentConversations) {
                    return Err(too_old("5.10"));
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
                if let Some(agent) = agent {
                    set(&mut args, "agent", Json::from(agent.clone()));
                }
                if !images.is_empty() {
                    set(&mut args, "images", Json::array(images.clone()));
                }
                self.set_bound_skills(&mut args, skills);
                set_attachments(&mut args, attachments);
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
            Call::Submit { text, when_busy, target, request_id, images, skills, attachments } => {
                if !images.is_empty() && !host_supports_feature(self.host_minor, HostFeature::Images) {
                    return Err(too_old_images());
                }
                // Same gate as createConversation.
                if has_image_ref(images) && !host_supports_feature(self.host_minor, HostFeature::ImageRefs) {
                    return Err(too_old_image_refs());
                }
                check_attachments(self.host_minor, attachments)?;
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
                let mut args = JsonObject::new();
                set(&mut args, "conversationId", Json::Number(conversation as f64));
                set(&mut args, "text", Json::from(text.clone()));
                set(&mut args, "whenBusy", Json::from(when_busy.clone()));
                set(&mut args, "requestId", Json::from(request_id.clone().unwrap_or_else(|| (self.request_id)())));
                if !images.is_empty() {
                    set(&mut args, "images", Json::array(images.clone()));
                }
                self.set_bound_skills(&mut args, skills);
                set_attachments(&mut args, attachments);
                steps.push_back(Step::Call { method: "submit", args: Json::Object(Arc::new(args)) });
            }
            Call::WithdrawQueued { submission_id, target } => {
                if !host_supports_call(self.host_minor, "withdrawQueued") {
                    return Err(too_old("5.14"));
                }
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[
                    ("conversationId", Json::Number(conversation as f64)),
                    ("submissionId", Json::Number(*submission_id as f64)),
                ]);
                steps.push_back(Step::Call { method: "withdrawQueued", args });
            }
            Call::SteerQueued { submission_id, target } => {
                if !host_supports_call(self.host_minor, "steerQueued") {
                    return Err(too_old("5.14"));
                }
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[
                    ("conversationId", Json::Number(conversation as f64)),
                    ("submissionId", Json::Number(*submission_id as f64)),
                ]);
                steps.push_back(Step::Call { method: "steerQueued", args });
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
            Call::RunCommand { name, args: input, target } => {
                if !host_supports_call(self.host_minor, "runCommand") {
                    return Err(too_old("5.17"));
                }
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
                let mut args = JsonObject::new();
                set(&mut args, "conversationId", Json::Number(conversation as f64));
                set(&mut args, "name", Json::from(name.clone()));
                if let Some(input) = input {
                    set(&mut args, "args", Json::from(input.clone()));
                }
                steps.push_back(Step::Call { method: "runCommand", args: Json::Object(Arc::new(args)) });
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
            Call::SetAgent { agent } => {
                if !host_supports_call(self.host_minor, "setAgent") {
                    return Err(too_old("5.18"));
                }
                let conversation = self.current.ok_or_else(|| "No conversation selected".to_string())?;
                let args = obj(&[
                    ("conversationId", Json::Number(conversation as f64)),
                    ("agent", agent.as_ref().map_or(Json::Null, |name| Json::from(name.clone()))),
                ]);
                steps.push_back(Step::Call { method: "setAgent", args });
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
            Call::Changes { target } => {
                let conversation = target.or(self.current).ok_or_else(|| "No conversation selected".to_string())?;
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
            Call::BeginLogin { provider_id, method } => {
                if !host_supports_call(self.host_minor, "beginLogin") {
                    return Err(too_old("5.21"));
                }
                let args = obj(&[
                    ("providerId", Json::from(provider_id.clone())),
                    ("method", Json::from(method.as_str())),
                ]);
                steps.push_back(Step::Call { method: "beginLogin", args });
            }
            Call::AnswerLogin { login_id, prompt_id, value } => {
                if !host_supports_call(self.host_minor, "answerLogin") {
                    return Err(too_old("5.21"));
                }
                let args = obj(&[
                    ("loginId", Json::from(login_id.clone())),
                    ("promptId", Json::Number(*prompt_id as f64)),
                    ("value", Json::from(value.clone())),
                ]);
                steps.push_back(Step::Call { method: "answerLogin", args });
            }
            Call::CancelLogin { login_id } => {
                if !host_supports_call(self.host_minor, "cancelLogin") {
                    return Err(too_old("5.21"));
                }
                let args = obj(&[("loginId", Json::from(login_id.clone()))]);
                steps.push_back(Step::Call { method: "cancelLogin", args });
            }
            Call::SaveCustomProvider { provider, api_key } => {
                if !host_supports_call(self.host_minor, "saveCustomProvider") {
                    return Err(too_old("5.21"));
                }
                let mut args = JsonObject::new();
                set(&mut args, "provider", provider.clone());
                match api_key {
                    ApiKeyChange::Keep => {}
                    ApiKeyChange::Remove => set(&mut args, "apiKey", Json::Null),
                    ApiKeyChange::Set(key) => set(&mut args, "apiKey", Json::from(key.clone())),
                }
                steps.push_back(Step::Call { method: "saveCustomProvider", args: Json::Object(Arc::new(args)) });
            }
            Call::RemoveCustomProvider { provider_id } => {
                if !host_supports_call(self.host_minor, "removeCustomProvider") {
                    return Err(too_old("5.21"));
                }
                let args = obj(&[("providerId", Json::from(provider_id.clone()))]);
                steps.push_back(Step::Call { method: "removeCustomProvider", args });
            }
            Call::ListEndpointModels { api, base_url, api_key, provider_id } => {
                if !host_supports_call(self.host_minor, "listEndpointModels") {
                    return Err(too_old("5.21"));
                }
                let mut args = JsonObject::new();
                set(&mut args, "api", Json::from(api.as_str()));
                set(&mut args, "baseUrl", Json::from(base_url.clone()));
                if let Some(key) = api_key {
                    set(&mut args, "apiKey", Json::from(key.clone()));
                }
                if let Some(provider_id) = provider_id {
                    set(&mut args, "providerId", Json::from(provider_id.clone()));
                }
                steps.push_back(Step::Call { method: "listEndpointModels", args: Json::Object(Arc::new(args)) });
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
                // Same for hostName on a pre-5.12 host — even the `null` reset.
                if patch.get("hostName").is_some()
                    && !host_supports_feature(self.host_minor, HostFeature::HostName)
                {
                    return Err(too_old("5.12"));
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
            Call::ListFiles { scope, query } => {
                if !host_supports_call(self.host_minor, "listFiles") {
                    return Err(too_old("5.10"));
                }
                let args = obj(&[("scope", scope.clone()), ("query", Json::from(query.clone()))]);
                steps.push_back(Step::Call { method: "listFiles", args });
            }
            Call::ListSkills { scope } => {
                if !host_supports_call(self.host_minor, "listSkills") {
                    return Err(too_old("5.13"));
                }
                steps.push_back(Step::Call { method: "listSkills", args: obj(&[("scope", scope.clone())]) });
            }
            Call::Image { ref_, variant } => {
                if !host_supports_call(self.host_minor, "image") {
                    return Err(too_old("5.15"));
                }
                let mut args = JsonObject::new();
                set(&mut args, "ref", Json::from(ref_.clone()));
                if *variant != ImageVariant::Original
                    && host_supports_feature(self.host_minor, HostFeature::ImageVariants)
                {
                    set(&mut args, "variant", Json::from(variant.as_str()));
                }
                steps.push_back(Step::Call { method: "image", args: Json::Object(Arc::new(args)) });
            }
            Call::ListCommands { conversation_id } => {
                if !host_supports_call(self.host_minor, "listCommands") {
                    return Err(too_old("5.17"));
                }
                let args = obj(&[("conversationId", Json::Number(*conversation_id as f64))]);
                steps.push_back(Step::Call { method: "listCommands", args });
            }
            Call::BeginAttachment { name, size } => {
                if !host_supports_call(self.host_minor, "beginAttachment") {
                    return Err(too_old("5.19"));
                }
                let args = obj(&[("name", Json::from(name.clone())), ("size", Json::Number(*size as f64))]);
                steps.push_back(Step::Call { method: "beginAttachment", args });
            }
            Call::AppendAttachment { attachment_id, offset, data } => {
                if !host_supports_call(self.host_minor, "appendAttachment") {
                    return Err(too_old("5.19"));
                }
                let args = obj(&[
                    ("attachmentId", Json::from(attachment_id.clone())),
                    ("offset", Json::Number(*offset as f64)),
                    ("data", Json::from(data.clone())),
                ]);
                steps.push_back(Step::Call { method: "appendAttachment", args });
            }
            Call::RetrySubmission { .. } | Call::TakeBackSubmission { .. } => {
                return Err("submission actions never reach the wire".to_string());
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
                        self.subscribe_stream(stream);
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
                        self.subscribe_stream(tasks.clone());
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
                if previous != Some(id) && self.conversation_is_fresh() {
                    self.conversation_fresh_epoch += 1;
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
        if (self.conn().is_none() && self.active_rtc.is_none()) || !connected {
            return Err("Not connected to the host".to_string());
        }
        let id = self.next_call;
        self.next_call += 1;
        let carrier = match self.active_rtc.as_ref().map(|carrier| carrier.peer) {
            Some(peer) => Some(CallCarrier::Peer(peer)),
            None => self.conn().map(|conn| CallCarrier::Conn(conn.id)),
        };
        self.pending_calls.insert(id, self.active[index].op_id);
        self.active[index].waiting = Some(Wait::Call);
        self.active[index].carrier = carrier;
        self.send(ClientFrame::Call { id: id as f64, method: U16String::from_str(method), args });
        Ok(())
    }

    /// Op finished: result to the caller, then the queue continues.
    fn complete_op(&mut self, index: usize, value: Option<Json>) {
        let op = self.active.remove(index);
        if let Some(submission) = self.op_submissions.remove(&op.op_id) {
            self.finish_submission_result(submission, value);
            self.out.push(Command::OperationSucceeded { op: op.op_id, value: None });
        } else {
            self.out.push(Command::OperationSucceeded { op: op.op_id, value });
        }
        self.pump();
    }

    /// Op failed mid-flight: a request reports the error; commands and the
    /// unqueued abort turn it into a notice and still report success —
    /// the #command/#request split plus abort's `.then(()=>{}, notice)`.
    fn fail_op(&mut self, index: usize, error: &str) {
        let op = self.active.remove(index);
        if let Some(submission) = self.op_submissions.remove(&op.op_id) {
            let carrier_lost = op.carrier.is_some_and(|carrier| !self.carrier_live(carrier));
            if carrier_lost || error == "Not connected to the host" {
                self.mark_submission_unknown(submission);
            } else {
                self.mark_submission_failed(submission, error);
            }
            self.out.push(Command::OperationSucceeded { op: op.op_id, value: None });
            self.pump();
            return;
        }
        self.finish_failed(op.op_id, op.kind, error, op.carrier);
    }

    /// Whether the business carrier a request went out on is still the live
    /// one. Retirement of a standby, signal, or older connection is not this
    /// request's loss.
    fn carrier_live(&self, carrier: CallCarrier) -> bool {
        match carrier {
            CallCarrier::Conn(id) => {
                self.dial.as_ref().and_then(|dial| dial.conn.as_ref()).map(|conn| conn.id)
                    == Some(id)
            }
            CallCarrier::Peer(peer) => {
                self.active_rtc.as_ref().map(|carrier| carrier.peer) == Some(peer)
            }
        }
    }

    fn finish_failed(
        &mut self,
        op_id: u64,
        kind: OpKind,
        error: &str,
        carrier: Option<CallCarrier>,
    ) {
        if let Some(index) = self.op_submissions.remove(&op_id) {
            // A local gate (image refs, attachments) refused it before the wire.
            self.mark_submission_failed(index, error);
            self.out.push(Command::OperationSucceeded { op: op_id, value: None });
            self.pump();
            return;
        }
        let carrier_lost = carrier.is_some_and(|carrier| !self.carrier_live(carrier));
        match kind {
            OpKind::Request | OpKind::Direct => {
                self.out.push(Command::OperationFailed {
                    op: op_id,
                    error: error.to_string(),
                    carrier_lost,
                });
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
    /// Whether the shown (or target) conversation has a run in flight.
    fn conversation_busy(&self, id: Option<u64>) -> bool {
        let Some(id) = id else { return false };
        let Some(view) = self.values.get(&conversation_stream(id).0) else { return false };
        view.get("docs")
            .and_then(|docs| docs.get("pi.live"))
            .and_then(|live| live.get("run"))
            .is_some()
    }

    fn submission_json(&self, record: &SubmissionRecord) -> Json {
        let mut object = JsonObject::new();
        set(&mut object, "requestId", Json::from(record.request_id.clone()));
        if let Some(id) = record.conversation_id {
            set(&mut object, "conversationId", Json::Number(id as f64));
        }
        set(&mut object, "text", Json::from(record.text.clone()));
        set(&mut object, "whenBusy", Json::from(record.when_busy.clone()));
        set(&mut object, "placement", Json::from(record.placement.as_str()));
        set(&mut object, "phase", Json::from(record.phase.as_str()));
        set(&mut object, "images", Json::array(record.images.clone()));
        set(
            &mut object,
            "skills",
            Json::array(record.skills.clone().unwrap_or_default().into_iter().map(Json::from).collect()),
        );
        set(
            &mut object,
            "attachments",
            Json::array(record.attachments.iter().cloned().map(Json::from).collect()),
        );
        if let Some(id) = record.submission_id {
            set(&mut object, "submissionId", Json::Number(id as f64));
        }
        if let Some(entry) = record.entry {
            set(&mut object, "entry", Json::Number(entry as f64));
        }
        if let Some(error) = &record.error {
            set(&mut object, "error", Json::from(error.clone()));
        }
        Json::Object(Arc::new(object))
    }

    fn submissions_json(&self) -> Json {
        Json::array(
            self.submissions
                .iter()
                .filter(|record| record.phase != SubmissionPhase::Settled)
                .map(|record| self.submission_json(record))
                .collect(),
        )
    }

    fn settle_submission(&mut self, index: usize) {
        if self.submissions[index].phase == SubmissionPhase::Settled {
            return;
        }
        self.submissions[index].phase = SubmissionPhase::Settled;
        self.submissions[index].error = None;
        self.clear_submission_timer(index);
    }

    fn clear_submission_timer(&mut self, index: usize) {
        self.retire_retry_resend(index);
        let Some(timer) = self.submissions[index].timer.take() else {
            return;
        };
        self.submission_timers.remove(&timer);
        self.out.push(Command::CancelDeadline { timer });
    }

    /// A retried resend is not an active op: its invoke is released by the
    /// result, by its 30s deadline, or by any other fact for the same logical
    /// submission. Keep the call id so a late result still reconciles.
    fn retire_retry_resend(&mut self, index: usize) {
        let call_id = self.submission_queries.iter().find_map(|(call_id, query)| match query {
            SubmissionQuery::RetryResend(record, _) if *record == index => Some(*call_id),
            _ => None,
        });
        let Some(call_id) = call_id else {
            return;
        };
        let Some(SubmissionQuery::RetryResend(_, op)) = self.submission_queries.remove(&call_id) else {
            return;
        };
        self.late_submission_calls.insert(call_id, index);
        self.out.push(Command::OperationSucceeded { op, value: None });
    }

    /// Take a timed-out submit out of the serialized queue while keeping its
    /// call id for a late result. This is the Rust counterpart of the TS
    /// timeout race releasing the command chain.
    fn retire_submission_op(&mut self, index: usize) {
        self.retire_retry_resend(index);
        let Some(position) = self
            .active
            .iter()
            .position(|op| self.op_submissions.get(&op.op_id) == Some(&index))
        else {
            return;
        };
        let op = self.active.remove(position);
        self.op_submissions.remove(&op.op_id);
        let calls: Vec<u64> = self
            .pending_calls
            .iter()
            .filter(|(_, op_id)| **op_id == op.op_id)
            .map(|(call_id, _)| *call_id)
            .collect();
        for call_id in calls {
            self.pending_calls.remove(&call_id);
            self.late_submission_calls.insert(call_id, index);
        }
        self.out.push(Command::OperationSucceeded {
            op: op.op_id,
            value: None,
        });
        self.pump();
    }

    fn start_submission_timer(&mut self, index: usize) {
        self.clear_submission_timer(index);
        let timer = self.next_timer;
        self.next_timer += 1;
        self.submissions[index].timer = Some(timer);
        self.submission_timers.insert(timer, index);
        self.out.push(Command::ScheduleDeadline {
            timer,
            delay_ms: SUBMISSION_TIMEOUT_MS,
        });
    }

    fn submission_entry_present(&self, index: usize) -> bool {
        let record = &self.submissions[index];
        let (Some(conversation), Some(entry)) = (record.conversation_id, record.entry) else {
            return false;
        };
        self.values
            .get(&conversation_stream(conversation).0)
            .and_then(|view| view.get("entries"))
            .and_then(Json::as_array)
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|item| item.get("id").and_then(|value| num_id(Some(value))) == Some(entry))
            })
    }

    fn submission_inbox_has(&self, index: usize) -> bool {
        let record = &self.submissions[index];
        let (Some(conversation), Some(submission)) = (record.conversation_id, record.submission_id) else {
            return false;
        };
        self.values
            .get(&doc_stream(&U16String::from_str("pi.inbox"), conversation).0)
            .and_then(|inbox| inbox.get("items"))
            .and_then(Json::as_array)
            .is_some_and(|items| items.iter().any(|item| item.get("id").and_then(|value| num_id(Some(value))) == Some(submission)))
    }
    /// Settle records whose entry or inbox row has now arrived; recheck an
    /// admitted entry a fresh snapshot lacks (a reset may have trimmed it).
    fn reconcile_submissions(&mut self) {
        for index in 0..self.submissions.len() {
            if self.submissions[index].phase == SubmissionPhase::Settled
                || self.submissions[index].submission_id.is_none()
            {
                continue;
            }
            if self.submission_entry_present(index) || self.submission_inbox_has(index) {
                self.settle_submission(index);
                continue;
            }
            let Some(conversation) = self.submissions[index].conversation_id else {
                continue;
            };
            if !self.submissions[index].admitted
                || (self.submissions[index].entry.is_none() && self.submission_inbox_has(index))
            {
                continue;
            }
            // Either the transcript or the inbox moving can turn an admitted
            // row into a stale one, so check once per version of both.
            let version = self
                .stream_versions
                .get(&conversation_stream(conversation).0)
                .copied()
                .unwrap_or(0)
                .wrapping_add(
                    self.stream_versions
                        .get(&doc_stream(&U16String::from_str("pi.inbox"), conversation).0)
                        .copied()
                        .unwrap_or(0),
                );
            if self.submissions[index].checked_version != Some(version)
                && self.fresh.contains(&conversation_stream(conversation).0)
                && !self.submissions[index].confirming
            {
                self.submissions[index].checked_version = Some(version);
                self.send_submission_query(index, SubmissionQuery::Confirm(index));
            }
        }
    }

    fn apply_submission_fact(&mut self, index: usize, fact: &Json) {
        let Some(submission_id) = fact.get("submissionId").and_then(|value| num_id(Some(value))) else {
            return;
        };
        let status = fact
            .get("status")
            .and_then(Json::as_str)
            .map(|value| value.to_string_lossy())
            .unwrap_or_default();
        let entry = fact.get("entry").and_then(|value| num_id(Some(value)));
        self.submissions[index].admitted = true;
        self.submissions[index].submission_id = Some(submission_id);
        self.submissions[index].error = None;
        self.clear_submission_timer(index);
        if let Some(entry) = entry {
            self.submissions[index].entry = Some(entry);
        }
        if self.submissions[index].entry.is_some() {
            if self.submission_entry_present(index) || status == "done" {
                self.settle_submission(index);
            } else {
                self.submissions[index].phase = SubmissionPhase::InFlight;
            }
        } else if self.submission_inbox_has(index) {
            self.settle_submission(index);
        } else if status == "placed" || status == "done" || status == "unanswered" {
            self.settle_submission(index);
        } else {
            self.submissions[index].phase = SubmissionPhase::InFlight;
        }
        let _ = self.refresh();
    }

    fn submission_query_args(&self, index: usize) -> Option<Json> {
        let record = &self.submissions[index];
        let conversation = record.conversation_id?;
        Some(obj(&[
            ("conversationId", Json::Number(conversation as f64)),
            ("requestId", Json::from(record.request_id.clone())),
        ]))
    }

    fn send_submission_query(&mut self, index: usize, kind: SubmissionQuery) -> Option<u64> {
        let args = self.submission_query_args(index)?;
        let id = self.next_call;
        self.next_call += 1;
        self.submission_queries.insert(id, kind);
        self.send(ClientFrame::Call {
            id: id as f64,
            method: U16String::from_str("submission"),
            args,
        });
        Some(id)
    }

    fn send_submission_resend(
        &mut self,
        index: usize,
        kind: SubmissionQuery,
    ) -> Option<u64> {
        let record = &self.submissions[index];
        let conversation = record.conversation_id?;
        let mut args = JsonObject::new();
        set(&mut args, "conversationId", Json::Number(conversation as f64));
        set(&mut args, "text", Json::from(record.text.clone()));
        set(&mut args, "whenBusy", Json::from(record.when_busy.clone()));
        set(&mut args, "requestId", Json::from(record.request_id.clone()));
        if !record.images.is_empty() {
            set(&mut args, "images", Json::array(record.images.clone()));
        }
        self.set_bound_skills(&mut args, &record.skills);
        set_attachments(&mut args, &record.attachments);
        let id = self.next_call;
        self.next_call += 1;
        self.submission_queries.insert(id, kind);
        self.send(ClientFrame::Call {
            id: id as f64,
            method: U16String::from_str("submit"),
            args: Json::Object(Arc::new(args)),
        });
        Some(id)
    }

    /// Start a retry resend and carry the operation that must resolve on it.
    fn send_submission_resend_query(
        &mut self,
        index: usize,
        kind: SubmissionQuery,
    ) -> Option<u64> {
        self.submissions[index].phase = SubmissionPhase::InFlight;
        self.submissions[index].error = None;
        self.start_submission_timer(index);
        let call = self.send_submission_resend(index, kind);
        let _ = self.refresh();
        call
    }

    fn finish_submission_result(&mut self, index: usize, value: Option<Json>) {
        let Some(value) = value else {
            self.mark_submission_unknown(index);
            return;
        };
        let Some(submission_id) = value.get("submissionId").and_then(|value| num_id(Some(value))) else {
            self.mark_submission_failed(index, "The submit result had no submissionId");
            return;
        };
        self.submissions[index].admitted = true;
        self.submissions[index].submission_id = Some(submission_id);
        self.submissions[index].error = None;
        self.clear_submission_timer(index);
        if let Some(entry) = value.get("entry").and_then(|value| num_id(Some(value))) {
            self.submissions[index].entry = Some(entry);
        }
        if !host_supports_feature(self.host_minor, HostFeature::SubmitEntry) {
            self.settle_submission(index);
        } else if self.submissions[index].entry.is_some() {
            self.submissions[index].phase = SubmissionPhase::InFlight;
            if self.submission_entry_present(index) {
                self.settle_submission(index);
            }
        } else {
            self.submissions[index].phase = SubmissionPhase::InFlight;
            if let Some(conversation) = self.submissions[index].conversation_id {
                // This query answers the current snapshot; the next one may re-ask.
                self.submissions[index].checked_version = Some(
                    self.stream_versions
                        .get(&conversation_stream(conversation).0)
                        .copied()
                        .unwrap_or(0)
                        .wrapping_add(
                            self.stream_versions
                                .get(&doc_stream(&U16String::from_str("pi.inbox"), conversation).0)
                                .copied()
                                .unwrap_or(0),
                        ),
                );
            }
            self.send_submission_query(index, SubmissionQuery::Confirm(index));
        }
        let _ = self.refresh();
    }

    fn mark_submission_unknown(&mut self, index: usize) {
        if self.submissions[index].phase == SubmissionPhase::Settled {
            return;
        }
        self.submissions[index].phase = SubmissionPhase::Unknown;
        self.clear_submission_timer(index);
        let _ = self.refresh();
    }

    fn mark_submission_failed(&mut self, index: usize, error: &str) {
        if self.submissions[index].phase == SubmissionPhase::Settled {
            return;
        }
        self.submissions[index].phase = SubmissionPhase::Failed;
        self.submissions[index].error = Some(error.to_string());
        self.clear_submission_timer(index);
        let _ = self.refresh();
    }
    /// Start a logical submission: create the record, then let the normal
    /// serialized queue carry its one wire `submit`.
    fn create_submission(&mut self, op: u64, call: Call) {
        let Call::Submit {
            text,
            when_busy,
            target,
            request_id,
            images,
            skills,
            attachments,
        } = call
        else {
            return;
        };
        let request_id = request_id.unwrap_or_else(|| (self.request_id)());
        if self.submission_by_request.contains_key(&request_id) {
            self.out.push(Command::OperationSucceeded { op, value: None });
            return;
        }
        let placement = if self.conversation_busy(target.or(self.current)) {
            SubmissionPlacement::Queue
        } else {
            SubmissionPlacement::Conversation
        };
        let index = self.submissions.len();
        self.submissions.push(SubmissionRecord {
            request_id: request_id.clone(),
            text: text.clone(),
            when_busy: when_busy.clone(),
            placement,
            phase: SubmissionPhase::Queued,
            images: images.clone(),
            skills: skills.clone(),
            attachments: attachments.clone(),
            conversation_id: target,
            fixed: target.is_some(),
            submission_id: None,
            entry: None,
            error: None,
            timer: None,
            admitted: false,
            confirming: false,
            checked_version: None,
        });
        self.submission_by_request.insert(request_id.clone(), index);
        self.queue.push_back((
            op,
            OpKind::Request,
            Call::Submit {
                text,
                when_busy,
                target,
                request_id: Some(request_id),
                images,
                skills,
                attachments,
            },
        ));
        let _ = self.refresh();
        self.pump();
    }

    /// The index of a submit's logical record, if this call is one.
    fn logical_submit_index(&self, call: &Call) -> Option<usize> {
        if !self.logical_submissions {
            return None;
        }
        let Call::Submit {
            request_id: Some(request_id),
            ..
        } = call
        else {
            return None;
        };
        self.submission_by_request.get(request_id).copied()
    }

    /// Resolve the conversation at first execution and start its timer.
    fn begin_logical_submit(&mut self, op_id: u64, index: usize, call: &Call) -> bool {
        if !self.submissions[index].fixed {
            let target = match call {
                Call::Submit { target, .. } => target.or(self.current),
                _ => self.current,
            };
            let Some(target) = target else {
                self.mark_submission_failed(index, "No conversation selected");
                self.out.push(Command::OperationSucceeded { op: op_id, value: None });
                self.pump();
                return true;
            };
            self.submissions[index].conversation_id = Some(target);
            self.submissions[index].fixed = true;
        }
        self.submissions[index].phase = SubmissionPhase::InFlight;
        self.submissions[index].error = None;
        self.op_submissions.insert(op_id, index);
        self.start_submission_timer(index);
        let _ = self.refresh();
        false
    }

    fn begin_submission_recovery(&mut self) -> bool {
        if !self.logical_submissions {
            return false;
        }
        let queue: VecDeque<usize> = self
            .submissions
            .iter()
            .enumerate()
            .filter(|(_, record)| record.phase == SubmissionPhase::Unknown && record.fixed)
            .map(|(index, _)| index)
            .collect();
        if queue.is_empty() {
            return false;
        }
        self.recovering_submissions = true;
        self.sync_gate = true;
        self.submission_recovery = queue;
        self.advance_submission_recovery();
        true
    }

    fn advance_submission_recovery(&mut self) {
        if !self.recovering_submissions {
            return;
        }
        while let Some(index) = self.submission_recovery.pop_front() {
            if self.submissions[index].phase != SubmissionPhase::Unknown {
                continue;
            }
            if !host_supports_call(self.host_minor, "submission") {
                continue;
            }
            if let Some(id) = self.send_submission_query(index, SubmissionQuery::RecoveryQuery(index)) {
                self.recovery_waiting = Some(id);
                return;
            }
        }
        self.recovering_submissions = false;
        self.recovery_waiting = None;
        self.sync_gate = false;
        let queued = std::mem::take(&mut self.sync_queue);
        for (op, _kind, call) in queued {
            self.invoke(op, call);
        }
        let _ = self.refresh();
    }

    fn retry_submission(&mut self, op: u64, request_id: &str) {
        let Some(index) = self.submission_by_request.get(request_id).copied() else {
            self.out.push(Command::OperationSucceeded { op, value: None });
            return;
        };
        if !matches!(self.submissions[index].phase, SubmissionPhase::Unknown | SubmissionPhase::Failed) {
            self.out.push(Command::OperationSucceeded { op, value: None });
            return;
        }
        if self.submissions[index].phase == SubmissionPhase::Unknown
            && host_supports_call(self.host_minor, "submission")
        {
            if self.send_submission_query(index, SubmissionQuery::RetryQuery(index, op)).is_some() {
                return;
            }
        }
        self.submissions[index].phase = SubmissionPhase::InFlight;
        self.submissions[index].error = None;
        self.start_submission_timer(index);
        if self
            .send_submission_resend(index, SubmissionQuery::RetryResend(index, op))
            .is_none()
        {
            self.mark_submission_failed(index, "No conversation selected");
            self.out.push(Command::OperationSucceeded { op, value: None });
        }
        let _ = self.refresh();
    }
    fn submission_draft_json(&self, index: usize) -> Json {
        let record = &self.submissions[index];
        let mut object = JsonObject::new();
        set(&mut object, "text", Json::from(record.text.clone()));
        set(&mut object, "whenBusy", Json::from(record.when_busy.clone()));
        set(&mut object, "images", Json::array(record.images.clone()));
        set(
            &mut object,
            "skills",
            Json::array(record.skills.clone().unwrap_or_default().into_iter().map(Json::from).collect()),
        );
        set(
            &mut object,
            "attachments",
            Json::array(record.attachments.iter().cloned().map(Json::from).collect()),
        );
        Json::Object(Arc::new(object))
    }

    fn take_back_submission(&mut self, op: u64, request_id: &str) {
        let Some(index) = self.submission_by_request.get(request_id).copied() else {
            self.out.push(Command::OperationSucceeded { op, value: None });
            return;
        };
        let phase = self.submissions[index].phase;
        if phase == SubmissionPhase::Queued || phase == SubmissionPhase::Failed {
            let draft = self.submission_draft_json(index);
            self.settle_submission(index);
            let _ = self.refresh();
            self.out.push(Command::OperationSucceeded {
                op,
                value: Some(draft),
            });
            return;
        }
        let can_query = phase == SubmissionPhase::Unknown
            || (phase == SubmissionPhase::InFlight && self.submissions[index].submission_id.is_some());
        if !can_query || !host_supports_call(self.host_minor, "submission") {
            self.out.push(Command::OperationSucceeded { op, value: None });
            return;
        }
        if self
            .send_submission_query(index, SubmissionQuery::TakeBackQuery(index, op))
            .is_none()
        {
            self.out.push(Command::OperationSucceeded { op, value: None });
        }
    }

    fn finish_take_back_withdraw(&mut self, index: usize, op: u64, outcome: Option<&Json>) {
        let withdrawn = outcome
            .and_then(|value| value.get("outcome"))
            .and_then(Json::as_str)
            .is_some_and(|value| value.to_string_lossy() == "withdrawn");
        let draft = if withdrawn {
            Some(self.submission_draft_json(index))
        } else {
            None
        };
        self.settle_submission(index);
        let _ = self.refresh();
        self.out.push(Command::OperationSucceeded { op, value: draft });
    }
    fn handle_submission_query(
        &mut self,
        call_id: u64,
        query: SubmissionQuery,
        ok: bool,
        value: Json,
    ) {
        if self.recovery_waiting == Some(call_id) {
            self.recovery_waiting = None;
        }
        match query {
            SubmissionQuery::Confirm(index) => {
                if ok && !matches!(value, Json::Null) {
                    self.apply_submission_fact(index, &value);
                } else if ok
                    && self.submissions[index].admitted
                    && self.submissions[index].entry.is_none()
                {
                    // A queued admit has no entry, and no record now: withdrawn
                    // or consumed past the visible queue, so the local row is
                    // over. A known entry still waits for its snapshot.
                    self.settle_submission(index);
                    let _ = self.refresh();
                }
            }
            SubmissionQuery::RecoveryQuery(index) => {
                if ok && !matches!(value, Json::Null) {
                    self.apply_submission_fact(index, &value);
                    self.advance_submission_recovery();
                } else if ok {
                    if let Some(id) = self.send_submission_resend(index, SubmissionQuery::RecoveryResend(index)) {
                        self.recovery_waiting = Some(id);
                    } else {
                        self.mark_submission_unknown(index);
                        self.advance_submission_recovery();
                    }
                } else {
                    self.mark_submission_unknown(index);
                    self.advance_submission_recovery();
                }
            }
            SubmissionQuery::RecoveryResend(index) => {
                if ok {
                    self.finish_submission_result(index, Some(value));
                } else {
                    self.mark_submission_unknown(index);
                }
                self.advance_submission_recovery();
            }
            SubmissionQuery::RetryQuery(index, op) => {
                if ok && !matches!(value, Json::Null) {
                    self.apply_submission_fact(index, &value);
                    self.out.push(Command::OperationSucceeded { op, value: None });
                } else if ok {
                    if self.send_submission_resend_query(index, SubmissionQuery::RetryResend(index, op)).is_none() {
                        self.mark_submission_failed(index, "No conversation selected");
                        self.out.push(Command::OperationSucceeded { op, value: None });
                    }
                } else {
                    self.mark_submission_unknown(index);
                    self.out.push(Command::OperationSucceeded { op, value: None });
                }
            }
            SubmissionQuery::RetryResend(index, op) => {
                if ok {
                    self.finish_submission_result(index, Some(value));
                } else {
                    self.mark_submission_unknown(index);
                }
                self.out.push(Command::OperationSucceeded { op, value: None });
            }
            SubmissionQuery::TakeBackQuery(index, op) => {
                if ok && !matches!(value, Json::Null) {
                    self.apply_submission_fact(index, &value);
                    let status = self.submissions[index]
                        .submission_id
                        .is_some();
                    if self.submissions[index].phase == SubmissionPhase::Settled
                        || self.submissions[index].entry.is_some()
                        || !status
                    {
                        self.out.push(Command::OperationSucceeded { op, value: None });
                    } else {
                        let conversation = self.submissions[index].conversation_id;
                        let submission = self.submissions[index].submission_id;
                        if let (Some(conversation), Some(submission)) = (conversation, submission) {
                            let args = obj(&[
                                ("conversationId", Json::Number(conversation as f64)),
                                ("submissionId", Json::Number(submission as f64)),
                            ]);
                            let id = self.next_call;
                            self.next_call += 1;
                            self.submission_queries.insert(
                                id,
                                SubmissionQuery::TakeBackWithdraw(index, op),
                            );
                            self.send(ClientFrame::Call {
                                id: id as f64,
                                method: U16String::from_str("withdrawQueued"),
                                args,
                            });
                        } else {
                            self.out.push(Command::OperationSucceeded { op, value: None });
                        }
                    }
                } else if ok {
                    let draft = self.submission_draft_json(index);
                    self.settle_submission(index);
                    let _ = self.refresh();
                    self.out.push(Command::OperationSucceeded { op, value: Some(draft) });
                } else {
                    self.out.push(Command::OperationSucceeded { op, value: None });
                }
            }
            SubmissionQuery::TakeBackWithdraw(index, op) => {
                if ok {
                    self.finish_take_back_withdraw(index, op, Some(&value));
                } else {
                    let error = U16String::js_string(&value).to_string_lossy();
                    self.out.push(Command::OperationFailed {
                        op,
                        error,
                        carrier_lost: false,
                    });
                }
            }
        }
    }
    fn refresh(&mut self) -> Result<(), String> {
        if self.state.is_none() {
            return Ok(());
        }
        self.reconcile_submissions();
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
        let providers = self.values.get(&key("providers")).cloned().unwrap_or(Json::Null);
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
        self.set_field("providers", providers);
        self.set_field("settings", settings);
        self.set_field("agents", agents);
        self.set_field("defaults", defaults);
        self.set_field("submissions", self.submissions_json());
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
        set(&mut state, "providers", Json::Null);
        set(&mut state, "settings", Json::Null);
        set(&mut state, "agents", Json::Null);
        set(&mut state, "host", self.host_info());
        self.state = Some(state);
        if let Err(error) = self.refresh() {
            self.state = None;
            return self.fail_channel(&error);
        }
        self.mark_dial_ready();
        if !self.ready_sent {
            self.ready_sent = true;
            self.out.push(Command::Ready {
                outcome: ReadyOutcome::Connected,
            });
        }
    }

    /// The current candidate completed every required snapshot. Cancel both
    /// its stage deadline and the whole-round budget before declaring ready.
    fn mark_dial_ready(&mut self) {
        self.clear_round_timer();
        self.clear_dial_timer();
        if let Some(dial) = &mut self.dial {
            dial.phase = Phase::Ready;
        }
        self.round_active = false;
        self.reconnect_remaining = None;
        self.attempt = 0;
        self.ever_ready = true;
        self.outage_noticed = false;
        if self.active_rtc.is_some() {
            self.finish_handoff();
            self.start_liveness();
            self.start_stable_timer();
        } else {
            if let Some(dial) = &self.dial {
                self.active_path = match dial.candidate.role {
                    RemoteCandidateRole::Loopback => ConnectionPath::Loopback,
                    RemoteCandidateRole::Relay | RemoteCandidateRole::Legacy => ConnectionPath::Relay,
                    RemoteCandidateRole::Direct => ConnectionPath::Direct,
                };
            }
            self.schedule_upgrade(UPGRADE_DELAY_MS);
        }
    }

    /// The shell becomes visible as soon as every host stream is fresh; the
    /// extended sync (conversations/docs) keeps calls queued behind the gate.
    fn maybe_reconnect_shell(&mut self) {
        if self.reconnect_remaining.is_none() || self.state.is_none() {
            return;
        }
        let host_ready = host_streams(self.host_minor)
            .into_iter()
            .all(|name| self.fresh.contains(&key(name)));
        if !host_ready || self.connection_is_connected() {
            return;
        }
        self.sync_gate = self
            .reconnect_remaining
            .as_ref()
            .is_some_and(|remaining| !remaining.is_empty());
        // The shell is visible; the per-dial sync deadline still bounds the
        // conversation/doc barrier, so the round budget must not fire first.
        self.clear_round_timer();
        self.round_active = false;
        if let Some(dial) = &mut self.dial {
            dial.phase = Phase::Ready;
        }
        self.set_field("connection", Json::from(CONNECTED));
    }

    fn connection_is_connected(&self) -> bool {
        self.state
            .as_ref()
            .and_then(|state| state.get(&key("connection")))
            .and_then(Json::as_str)
            .is_some_and(|value| value.to_string_lossy() == CONNECTED)
    }

    /// A reconnect's fresh snapshots arrived: the connection is usable again.
    fn finish_reconnect(&mut self) {
        self.reconnect_remaining = None;
        self.set_field("connection", Json::from(CONNECTED));
        if let Err(error) = self.refresh() {
            return self.fail_channel(&error);
        }
        self.mark_dial_ready();
        // Unknown submissions are resolved in order before queued commands
        // may run; their queries and resends use this live connection
        // directly, not the gate they are holding (ADR-0034 §6).
        if self.begin_submission_recovery() {
            return;
        }
        self.sync_gate = false;
        let queued = std::mem::take(&mut self.sync_queue);
        for (op, _kind, call) in queued {
            self.invoke(op, call);
        }
    }
}

fn op_kind(call: &Call) -> OpKind {
    match call {
        Call::AddProject { .. }
        | Call::ListFolders { .. }
        | Call::RenameConversation { .. }
        | Call::Changes { .. }
        | Call::CreatePairing
        | Call::CreateAgent { .. }
        | Call::UpdateAgent { .. }
        | Call::DeleteAgent { .. }
        | Call::SetPushToken { .. }
        | Call::WithdrawQueued { .. }
        | Call::SteerQueued { .. }
        | Call::BeginLogin { .. }
        | Call::AnswerLogin { .. }
        | Call::CancelLogin { .. }
        | Call::SaveCustomProvider { .. }
        | Call::RemoveCustomProvider { .. } => OpKind::Request,
        Call::Abort { .. } => OpKind::Unqueued,
        Call::ListFiles { .. }
        | Call::ListSkills { .. }
        | Call::Image { .. }
        | Call::ListCommands { .. }
        | Call::BeginAttachment { .. }
        | Call::AppendAttachment { .. }
        | Call::ListEndpointModels { .. } => OpKind::Direct,
        _ => OpKind::Command,
    }
}

fn describe_failure(failure: &CandidateFailure) -> String {
    let role = match failure.candidate.role {
        RemoteCandidateRole::Loopback => "local",
        RemoteCandidateRole::Relay => "relay",
        RemoteCandidateRole::Direct => "direct",
        RemoteCandidateRole::Legacy => "legacy",
    };
    let where_ = format!("{role} {}", failure.candidate.url);
    if failure.stage == CandidateFailureStage::Unsupported {
        return format!(
            "{where_} skipped ({})",
            failure.reason.as_deref().unwrap_or("unsupported")
        );
    }
    let code = failure
        .code
        .map(|code| format!(" (close {code})"))
        .unwrap_or_default();
    let reason = failure
        .reason
        .as_deref()
        .map(|reason| format!(": {reason}"))
        .unwrap_or_default();
    format!(
        "{where_} failed at {}{code}{reason}",
        failure.stage.as_str()
    )
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

/// Whether any outgoing image is the ref form `{ ref }` with no inline
/// bytes; a block carrying both is a bytes block on the wire.
fn has_image_ref(images: &[Json]) -> bool {
    images.iter().any(|image| {
        let has_bytes = image.get("data").and_then(Json::as_str).is_some_and(|data| !data.is_empty());
        !has_bytes
            && image
                .get("ref")
                .and_then(Json::as_str)
                .is_some_and(|reference| !reference.is_empty())
    })
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
