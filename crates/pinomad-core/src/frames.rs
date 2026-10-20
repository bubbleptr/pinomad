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
pub const PROTOCOL: ProtocolVersion = ProtocolVersion { major: 5, minor: 11 };

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

/// Minor version that introduced each call (`CALL_SINCE`); absent → 5.0.
fn call_since(method: &str) -> u32 {
    match method {
        "logout" => 1,
        "updateSettings" => 2,
        "listFolders" => 3,
        "renameConversation" => 4,
        "createAgent" | "updateAgent" | "deleteAgent" => 6,
        "setPushToken" => 7,
        "listFiles" => 10,
        _ => 0,
    }
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
    Hello(Json),
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
    Subscribe { stream: U16String },
    Unsubscribe { stream: U16String },
    Call { id: f64, method: U16String, args: Json },
}

pub fn encode_client_frame(frame: &ClientFrame) -> String {
    let mut object = JsonObject::new();
    let stream_of = |stream: &U16String| Json::String(stream.clone());
    match frame {
        ClientFrame::Subscribe { stream } => {
            object.set(U16String::from_str("type"), Json::from("subscribe"));
            object.set(U16String::from_str("stream"), stream_of(stream));
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
