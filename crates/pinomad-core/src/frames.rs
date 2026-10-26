// The gateway frames, client side (packages/protocol/src/frames.ts).
//
// ADR-0018 §4: frame types and fields this build does not know are ignored,
// never fatal — so decoding keeps raw Json fields around and only extracts
// what the state machine reads. parseClientFrame (the host-side validator)
// is out of scope here: this crate is the client.

use crate::json::{Json, JsonObject};
use crate::u16str::U16String;
use std::sync::Arc;

/// Close code for a rejected token or revoked device; never reconnect.
pub const UNAUTHORIZED_CLOSE_CODE: u16 = 4401;
/// Close code for a malformed client frame; terminal like 4401 (ADR-0018 §4).
pub const INVALID_FRAME_CLOSE_CODE: u16 = 4400;

/// The protocol this build speaks (ADR-0018): `major` gates compatibiliy,
/// `minor` the host features. Integers, not floats — the version will be
/// compared across the UniFFI boundary, and a protocol's parts are never
/// fractional.
pub const PROTOCOL: ProtocolVersion = ProtocolVersion { major: 5, minor: 23 };

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

/// `protocol.minor` as announced by a hello: absent/null reads as 0 (a
/// host too old to declare it); anything present must be a non-negative
/// integer that fits u32, else the hello is malformed. The reference's
/// `>=` comparisons silently coerce "8" or 8.5 — tightening that here
/// surfaces a broken peer instead of silently gating features on junk.
pub fn minor_version(value: Option<&Json>) -> Result<u32, String> {
    match value {
        None | Some(Json::Null) => Ok(0),
        Some(Json::Number(v)) if *v >= 0.0 && v.fract() == 0.0 && *v <= u32::MAX as f64 => {
            Ok(*v as u32)
        }
        _ => Err("hello protocol.minor is not a non-negative integer".to_string()),
    }
}

/// Minor version that introduced each host stream (the `HOST_STREAMS`
/// table). Every client subscribes to the ones its host's minor covers.
pub const HOST_STREAMS: &[(&str, u32)] = &[
    ("conversations", 0),
    ("index", 0),
    ("devices", 0),
    ("mcp", 0),
    ("models", 1),
    ("auth", 1),
    ("settings", 2),
    ("agents", 6),
    ("providers", 21),
];

/// The host streams a host of the given minor version knows, in declaration
/// order (Object.keys order in the reference).
pub fn host_streams(host_minor: u32) -> Vec<&'static str> {
    HOST_STREAMS
        .iter()
        .filter(|(_, since)| *since <= host_minor)
        .map(|(name, _)| *name)
        .collect()
}

pub fn host_stream_names() -> Vec<&'static str> {
    HOST_STREAMS.iter().map(|(name, _)| *name).collect()
}

/// Every call method in the protocol (`CallMethods` in frames.ts). Keeping
/// this as an enum makes the since table exhaustive: a TS addition without a
/// Rust variant fails the comparison vectors, which carry every call name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallMethod {
    AddProject,
    RemoveProject,
    ListFolders,
    CreateConversation,
    Archive,
    RenameConversation,
    Submit,
    WithdrawQueued,
    SteerQueued,
    Abort,
    Compact,
    SetModel,
    SetThinkingLevel,
    SetAgent,
    Fork,
    Answer,
    Changes,
    CreatePairing,
    RevokeDevice,
    Logout,
    BeginLogin,
    AnswerLogin,
    CancelLogin,
    SaveCustomProvider,
    RemoveCustomProvider,
    ListEndpointModels,
    UpdateSettings,
    CreateAgent,
    UpdateAgent,
    DeleteAgent,
    SetPushToken,
    ListFiles,
    ListSkills,
    Image,
    ListCommands,
    RunCommand,
    BeginAttachment,
    AppendAttachment,
    RtcOffer,
    Ping,
}

impl CallMethod {
    /// Parse the wire name. Unknown names are not protocol errors here: the
    /// client keeps its historical 5.0 fallback (see `call_since`).
    pub fn from_str(method: &str) -> Option<Self> {
        Some(match method {
            "addProject" => Self::AddProject,
            "removeProject" => Self::RemoveProject,
            "listFolders" => Self::ListFolders,
            "createConversation" => Self::CreateConversation,
            "archive" => Self::Archive,
            "renameConversation" => Self::RenameConversation,
            "submit" => Self::Submit,
            "withdrawQueued" => Self::WithdrawQueued,
            "steerQueued" => Self::SteerQueued,
            "abort" => Self::Abort,
            "compact" => Self::Compact,
            "setModel" => Self::SetModel,
            "setThinkingLevel" => Self::SetThinkingLevel,
            "setAgent" => Self::SetAgent,
            "fork" => Self::Fork,
            "answer" => Self::Answer,
            "changes" => Self::Changes,
            "createPairing" => Self::CreatePairing,
            "revokeDevice" => Self::RevokeDevice,
            "logout" => Self::Logout,
            "beginLogin" => Self::BeginLogin,
            "answerLogin" => Self::AnswerLogin,
            "cancelLogin" => Self::CancelLogin,
            "saveCustomProvider" => Self::SaveCustomProvider,
            "removeCustomProvider" => Self::RemoveCustomProvider,
            "listEndpointModels" => Self::ListEndpointModels,
            "updateSettings" => Self::UpdateSettings,
            "createAgent" => Self::CreateAgent,
            "updateAgent" => Self::UpdateAgent,
            "deleteAgent" => Self::DeleteAgent,
            "setPushToken" => Self::SetPushToken,
            "listFiles" => Self::ListFiles,
            "listSkills" => Self::ListSkills,
            "image" => Self::Image,
            "listCommands" => Self::ListCommands,
            "runCommand" => Self::RunCommand,
            "beginAttachment" => Self::BeginAttachment,
            "appendAttachment" => Self::AppendAttachment,
            "rtcOffer" => Self::RtcOffer,
            "ping" => Self::Ping,
            _ => return None,
        })
    }

    /// Minor version that introduced the call (`CALL_SINCE`); 0 is 5.0.
    /// No default arm: a new variant must state its gate.
    pub fn since(self) -> u32 {
        match self {
            Self::AddProject
            | Self::RemoveProject
            | Self::CreateConversation
            | Self::Archive
            | Self::Submit
            | Self::Abort
            | Self::Compact
            | Self::SetModel
            | Self::SetThinkingLevel
            | Self::Fork
            | Self::Answer
            | Self::Changes
            | Self::CreatePairing
            | Self::RevokeDevice => 0,
            Self::ListFolders => 3,
            Self::RenameConversation => 4,
            Self::Logout => 1,
            Self::UpdateSettings => 2,
            Self::CreateAgent | Self::UpdateAgent | Self::DeleteAgent => 6,
            Self::SetPushToken => 7,
            Self::ListFiles => 10,
            Self::ListSkills => 13,
            Self::WithdrawQueued | Self::SteerQueued => 14,
            Self::Image => 15,
            Self::ListCommands | Self::RunCommand => 17,
            Self::SetAgent => 18,
            Self::BeginAttachment | Self::AppendAttachment => 19,
            Self::BeginLogin
            | Self::AnswerLogin
            | Self::CancelLogin
            | Self::SaveCustomProvider
            | Self::RemoveCustomProvider
            | Self::ListEndpointModels => 21,
            Self::RtcOffer | Self::Ping => 23,
        }
    }
}

/// Minor version that introduced each call (`CALL_SINCE`); unknown methods
/// keep the historical 5.0 fallback.
fn call_since(method: &str) -> u32 {
    CallMethod::from_str(method).map_or(0, CallMethod::since)
}

/// Whether a host of the given minor version knows `method`.
pub fn host_supports_call(host_minor: u32, method: &str) -> bool {
    host_minor >= call_since(method)
}

/// Minor version that introduced each call-arg feature (`FEATURE_SINCE`).
pub fn host_supports_feature(host_minor: u32, feature: HostFeature) -> bool {
    let since = match feature {
        HostFeature::Images => 5,
        HostFeature::AcceptAccountDevices => 8,
        HostFeature::ApnsPush => 9,
        HostFeature::AgentConversations => 10,
        HostFeature::LiveBranch => 11,
        HostFeature::HostName => 12,
        HostFeature::ImageRefs => 15,
        HostFeature::BoundSkills => 16,
        HostFeature::Attachments => 19,
        HostFeature::ImageVariants => 20,
        HostFeature::Rtc => 23,
    };
    host_minor >= since
}

#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum HostFeature {
    Images,
    AcceptAccountDevices,
    /// The `{apns, environment}` object form of a `setPushToken` arg —
    /// gated like `images` because an older host would call it malformed
    /// and 4400 the connection (ADR-0025 §7).
    ApnsPush,
    /// `createConversation`'s `agent` field — an older host ignores it and
    /// silently creates an unassigned conversation (ADR-0023 §8).
    AgentConversations,
    /// `changes()` reports the checkout's live `branch` (11) — on an older
    /// host an absent branch says nothing, so the worktree record stands in.
    LiveBranch,
    /// `updateSettings`'s `hostName` key (12) — an older host would call the
    /// patch malformed and 4400 the connection.
    HostName,
    /// `submit`/`createConversation` images given as `{ref}` (15) — the
    /// host answers with the type it recorded; an older host would call the
    /// form malformed and 4400 the connection.
    ImageRefs,
    /// `submit`/`createConversation` carry `skills`, the `$` picks the host
    /// expands (16, ADR-0028) — an older host ignores the field, so the
    /// core leaves it off instead of refusing the call.
    BoundSkills,
    /// `submit`/`createConversation` carry `attachments` (19, issue #321) —
    /// an older host calls the field malformed and 4400s the connection.
    Attachments,
    ImageVariants,
    /// `hello.rtc` is present and the host answers `rtcOffer` (23, ADR-0033).
    Rtc,
}


/// `hello.rtc` (ADR-0033): the host's STUN list and the signal-only
/// capability. Absent/null means the native module is not loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRtc {
    pub stun: Vec<String>,
    pub signal_only: bool,
}

impl HostRtc {
    /// The minimal hello's RTC block, encoded the way the TS host does.
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        object.set(
            U16String::from_str("stun"),
            Json::array(self.stun.iter().map(|server| Json::from(server.clone())).collect()),
        );
        object.set(U16String::from_str("signalOnly"), Json::Bool(self.signal_only));
        Json::Object(Arc::new(object))
    }
}

/// Parse `hello.rtc`; a malformed block is a hello error, not a silently
/// disabled feature. Absent or null is `None` (an older host or no module).
pub fn parse_host_rtc(hello: &Json) -> Result<Option<HostRtc>, String> {
    let Some(value) = hello.get("rtc") else {
        return Ok(None);
    };
    if matches!(value, Json::Null) {
        return Ok(None);
    }
    if !value.is_object() {
        return Err("hello.rtc is not an object".to_string());
    }
    let stun = value
        .get("stun")
        .and_then(Json::as_array)
        .ok_or_else(|| "hello.rtc.stun is not an array".to_string())?;
    let mut servers = Vec::with_capacity(stun.len());
    for server in stun.iter() {
        let text = server
            .as_str()
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "hello.rtc.stun has a non-string or empty entry".to_string())?;
        servers.push(text.to_string_lossy());
    }
    if !matches!(value.get("signalOnly"), Some(Json::Bool(true))) {
        return Err("hello.rtc.signalOnly is not true".to_string());
    }
    Ok(Some(HostRtc { stun: servers, signal_only: true }))
}

/// `rtcOffer` arguments (ADR-0033 §4); both fields are non-empty strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RtcOfferArgs {
    pub attempt: String,
    pub sdp: String,
}

/// The record layer never exceeds this; one record is one DataChannel message.
pub const RTC_MAX_RECORD_BYTES: u64 = 65_535;
/// Absent `a=max-message-size` means the browsers' 65536 default.
pub const RTC_DEFAULT_MAX_MESSAGE_SIZE: u64 = 65_536;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RtcMaxMessageSize {
    Bounded(u64),
    Unlimited,
    Invalid(String),
}

/// Parse the peer's SDP send limit (`a=max-message-size`), matching
/// `parseRtcMaxMessageSize` in the TS reference: absent is 65536, 0 is
/// unlimited, anything below one full record is invalid.
pub fn parse_rtc_max_message_size(sdp: &str) -> RtcMaxMessageSize {
    let mut line = None;
    for entry in sdp.split('\n') {
        let entry = entry.strip_suffix('\r').unwrap_or(entry);
        if let Some(rest) = entry.strip_prefix("a=max-message-size:") {
            line = Some(rest.trim());
            break;
        }
    }
    let Some(raw) = line else {
        return RtcMaxMessageSize::Bounded(RTC_DEFAULT_MAX_MESSAGE_SIZE);
    };
    if raw.is_empty() || !raw.chars().all(|ch| ch.is_ascii_digit()) {
        return RtcMaxMessageSize::Invalid(format!("malformed a=max-message-size: {raw}"));
    }
    let Ok(bytes) = raw.parse::<u64>() else {
        return RtcMaxMessageSize::Invalid(format!("a=max-message-size is not a safe integer: {raw}"));
    };
    if bytes == 0 {
        return RtcMaxMessageSize::Unlimited;
    }
    if bytes < RTC_MAX_RECORD_BYTES {
        return RtcMaxMessageSize::Invalid(format!(
            "a=max-message-size {bytes} cannot carry a {RTC_MAX_RECORD_BYTES}-byte record"
        ));
    }
    RtcMaxMessageSize::Bounded(bytes)
}

pub fn parse_rtc_offer_args(args: &Json) -> Result<RtcOfferArgs, String> {
    let attempt = args
        .get("attempt")
        .and_then(Json::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "rtcOffer.attempt is not a non-empty string".to_string())?;
    let sdp = args
        .get("sdp")
        .and_then(Json::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "rtcOffer.sdp is not a non-empty string".to_string())?;
    Ok(RtcOfferArgs { attempt: attempt.to_string_lossy(), sdp: sdp.to_string_lossy() })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ImageVariant {
    Original,
    Thumbnail,
    Preview,
}

impl Default for ImageVariant {
    fn default() -> Self {
        Self::Original
    }
}

impl ImageVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Thumbnail => "thumbnail",
            Self::Preview => "preview",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "original" => Self::Original,
            "thumbnail" => Self::Thumbnail,
            "preview" => Self::Preview,
            _ => return None,
        })
    }
}

/// `ApnsEnvironment` — matches the build's `aps-environment` entitlement.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ApnsEnvironment {
    Production,
    Development,
}

impl ApnsEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            ApnsEnvironment::Production => "production",
            ApnsEnvironment::Development => "development",
        }
    }
}

/// `ApnsPushToken` — the APNs registration form of a `setPushToken` arg.
/// The legacy Expo string form is deliberately not modeled: the host
/// refuses it anyway, and native clients only ever send APNs or `null`.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ApnsPushToken {
    /// The device token APNs issued, hex — Apple does not fix its length.
    pub apns: String,
    pub environment: ApnsEnvironment,
}

/// `conversation:<id>` — the stream carrying one conversation's view.
pub fn conversation_stream(id: u64) -> U16String {
    U16String::from_str(&format!("conversation:{id}"))
}

/// `doc:<kind>:<id>` — one conversation document stream.
pub fn doc_stream(kind: &U16String, id: u64) -> U16String {
    let mut out = Vec::with_capacity(kind.len() + 16);
    out.extend("doc:".encode_utf16());
    out.extend_from_slice(&kind.0);
    out.extend(":".encode_utf16());
    out.extend_from_slice(&crate::json::number_to_units(id as f64));
    U16String(out)
}

/// What a server frame decoded to. Payload fields stay Json: unknown fields
/// ride along untouched, and the state machine reads defensively — exactly
/// what the reference's untyped access does.
#[derive(Clone, Debug)]
pub enum ServerFrame {
    /// The business hello (5.0+), with every business field.
    Hello(Json),
    /// The minimal hello of a signal-only connection (5.23, ADR-0033 §1);
    /// it carries only `protocol` and, when available, `rtc`.
    SignalHello(Json),
    Snapshot { stream: Json, value: Json },
    Ops { stream: Json, ops: Json },
    Ended { stream: Json, reason: Json },
    /// A call reply: `ok` truthy resolves with `value`, falsy rejects with
    /// `error` — the reference reads `frame.value`/`frame.error` directly.
    Result { id: Json, ok: Json, value: Json, error: Json },
    Notice { level: Json, message: Json },
    /// A type this build does not know, or a frame without a usable shape.
    Ignored,
}

const MISSING: Json = Json::Null;

fn field<'a>(frame: &'a Json, name: &str) -> &'a Json {
    frame.get(name).unwrap_or(&MISSING)
}

/// `JSON.parse(text)` then classify — the reference reads `frame.type` off
/// whatever parsed; non-records and unknown types are ignored outright.
pub fn decode_server_frame(text: &str) -> Result<ServerFrame, crate::json::ParseError> {
    let value = Json::parse(text)?;
    Ok(classify_server_frame(value))
}

pub fn classify_server_frame(value: Json) -> ServerFrame {
    if !value.is_object() {
        return ServerFrame::Ignored;
    }
    let kind = match field(&value, "type").as_str() {
        Some(kind) => kind.to_string_lossy(),
        None => return ServerFrame::Ignored,
    };
    match kind.as_str() {
        "hello" => ServerFrame::Hello(value),
        "signalHello" => ServerFrame::SignalHello(value),
        "snapshot" => ServerFrame::Snapshot {
            stream: field(&value, "stream").clone(),
            value: field(&value, "value").clone(),
        },
        "ops" => ServerFrame::Ops {
            stream: field(&value, "stream").clone(),
            ops: field(&value, "ops").clone(),
        },
        "ended" => ServerFrame::Ended {
            stream: field(&value, "stream").clone(),
            reason: field(&value, "reason").clone(),
        },
        "result" => ServerFrame::Result {
            id: field(&value, "id").clone(),
            ok: field(&value, "ok").clone(),
            value: field(&value, "value").clone(),
            error: field(&value, "error").clone(),
        },
        "notice" => ServerFrame::Notice {
            level: field(&value, "level").clone(),
            message: field(&value, "message").clone(),
        },
        _ => ServerFrame::Ignored,
    }
}

/// Client → host frames; the wire text is `JSON.stringify` of the object.
#[derive(Clone, Debug)]
pub enum ClientFrame {
    /// `images` asks a 5.15 host to send `{ref}` blocks for a
    /// `conversation:` stream (ADR-0027); other streams ignore it.
    Subscribe { stream: U16String, images: bool },
    Unsubscribe { stream: U16String },
    Call { id: f64, method: U16String, args: Json },
}

pub fn encode_client_frame(frame: &ClientFrame) -> String {
    let mut object = JsonObject::new();
    let stream_of = |stream: &U16String| Json::String(stream.clone());
    match frame {
        ClientFrame::Subscribe { stream, images } => {
            object.set(U16String::from_str("type"), Json::from("subscribe"));
            object.set(U16String::from_str("stream"), stream_of(stream));
            if *images {
                object.set(U16String::from_str("images"), Json::from("ref"));
            }
        }
        ClientFrame::Unsubscribe { stream } => {
            object.set(U16String::from_str("type"), Json::from("unsubscribe"));
            object.set(U16String::from_str("stream"), stream_of(stream));
        }
        ClientFrame::Call { id, method, args } => {
            object.set(U16String::from_str("type"), Json::from("call"));
            object.set(U16String::from_str("id"), Json::Number(*id));
            object.set(U16String::from_str("method"), Json::String(method.clone()));
            object.set(U16String::from_str("args"), args.clone());
        }
    }
    Json::Object(Arc::new(object)).to_json()
}
