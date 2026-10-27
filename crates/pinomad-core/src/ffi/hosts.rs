// Stored-host records at the boundary: the keychain keeps a Codable of
// `StoredHost`; `validate_stored_host` re-checks what the platform read
// back before it builds a connection (same rules as `parse_stored_host`).

use crate::b64::from_base64url;
use crate::endpoints::{
    EndpointSet as CoreEndpointSet, HostEndpointRole, ParsedEndpointSet, parse_endpoint_set,
};
use crate::json::{Json, JsonObject};
use crate::u16str::U16String;

/// The path role a published endpoint plays (ADR-0032).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum EndpointRole {
    Direct,
    Relay,
}

impl EndpointRole {
    fn as_str(self) -> &'static str {
        match self {
            EndpointRole::Direct => "direct",
            EndpointRole::Relay => "relay",
        }
    }
}

/// One socket the host published (only WebSocket today, so transport is
/// implicit at the boundary).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HostEndpoint {
    pub role: EndpointRole,
    pub url: String,
}

/// The host's remote candidates; an empty set is a valid "no remote entry".
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct EndpointSet {
    pub schema_version: u32,
    pub endpoints: Vec<HostEndpoint>,
}

impl EndpointSet {
    pub(crate) fn from_core(set: &CoreEndpointSet) -> Self {
        EndpointSet {
            schema_version: set.schema_version,
            endpoints: set
                .endpoints
                .iter()
                .map(|endpoint| HostEndpoint {
                    role: match endpoint.role {
                        HostEndpointRole::Direct => EndpointRole::Direct,
                        HostEndpointRole::Relay => EndpointRole::Relay,
                    },
                    url: endpoint.url.to_string_lossy(),
                })
                .collect(),
        }
    }

    /// Validate a record coming back from the platform. A malformed or
    /// future set costs only that field, never the pairing or host.
    pub(crate) fn to_core(&self) -> Option<CoreEndpointSet> {
        let mut object = JsonObject::new();
        object.set(
            U16String::from_str("schemaVersion"),
            Json::Number(self.schema_version as f64),
        );
        object.set(
            U16String::from_str("endpoints"),
            Json::array(
                self.endpoints
                    .iter()
                    .map(|endpoint| {
                        let mut entry = JsonObject::new();
                        entry.set(U16String::from_str("transport"), Json::from("webSocket"));
                        entry.set(
                            U16String::from_str("role"),
                            Json::from(endpoint.role.as_str()),
                        );
                        entry.set(U16String::from_str("url"), Json::from(endpoint.url.clone()));
                        Json::Object(std::sync::Arc::new(entry))
                    })
                    .collect(),
            ),
        );
        match parse_endpoint_set(Some(&Json::Object(std::sync::Arc::new(object)))) {
            ParsedEndpointSet::Valid(set) => Some(set),
            _ => None,
        }
    }
}

/// A pairing link's destination: the socket URL, the host's key (base64url,
/// as `StoredHost.host_key`), and the invite's remote candidates when present.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PairingTarget {
    pub url: String,
    pub host_key: String,
    #[uniffi(default = None)]
    pub endpoint_set: Option<EndpointSet>,
}

/// The account linkage of a paired host (ADR-0022): which server bound the
/// host and under what hostId.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct StoredHostAccount {
    pub server_origin: String,
    /// base64url of the host's 32-byte relay key, like `host_key`.
    pub host_id: String,
}

/// One paired host: where to dial and this device's identity on it — what
/// `FfiCommand::Paired` reports and the keychain persists.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct StoredHost {
    /// `ws://` or `wss://` socket URL (legacy / fallback).
    pub url: String,
    /// base64url of the host's 32-byte Noise static key.
    pub host_key: String,
    /// base64url of this device's 32-byte Noise private key.
    pub private_key: String,
    /// The machine's display name, cached from the host's settings (5.12);
    /// `None` keeps the existing constructor shape compiling.
    #[uniffi(default = None)]
    pub name: Option<String>,
    /// Account binding; a malformed stored link drops it, not the pairing.
    #[uniffi(default = None)]
    pub account: Option<StoredHostAccount>,
    /// The host's last published remote candidates (5.22, ADR-0032).
    #[uniffi(default = None)]
    pub endpoint_set: Option<EndpointSet>,
    /// `auto` | `directOnly` | `relayOnly`; None means Auto. The default
    /// keeps existing Swift initializers compiling.
    #[uniffi(default = None)]
    pub connection_mode: Option<String>,
    /// The learned `hello.rtc.signalOnly` hint; None means unknown.
    #[uniffi(default = None)]
    pub rtc_signal_only: Option<bool>,
}

/// One failed candidate path, for connection diagnostics.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CandidateFailure {
    pub url: String,
    pub role: String,
    pub stage: String,
    pub unauthorized: bool,
    pub code: Option<u16>,
    pub reason: Option<String>,
}

impl CandidateFailure {
    pub(crate) fn from_core(failure: &crate::remote_durable::CandidateFailure) -> Self {
        CandidateFailure {
            url: failure.candidate.url.clone(),
            role: failure.candidate.role.as_str().to_string(),
            stage: failure.stage.as_str().to_string(),
            unauthorized: failure.unauthorized,
            code: failure.code,
            reason: failure.reason.clone(),
        }
    }
}

/// Why a keychain record fails `validate_stored_host`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Error)]
pub enum StoredHostError {
    /// `url` is not a ws:/wss: URL.
    InvalidUrl,
    /// `hostKey` is not base64url of 32 bytes.
    InvalidHostKey,
    /// `privateKey` is not base64url of 32 bytes.
    InvalidPrivateKey,
}

impl std::fmt::Display for StoredHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            StoredHostError::InvalidUrl => "stored host url is not a ws:/wss: URL",
            StoredHostError::InvalidHostKey => "stored hostKey is not base64url of 32 bytes",
            StoredHostError::InvalidPrivateKey => "stored privateKey is not base64url of 32 bytes",
        })
    }
}

impl std::error::Error for StoredHostError {}

fn is_key(text: &str) -> bool {
    from_base64url(text)
        .map(|bytes| bytes.len() == 32)
        .unwrap_or(false)
}

fn is_host_url(text: &str) -> bool {
    match url::Url::parse(text) {
        Ok(url) => url.scheme() == "ws" || url.scheme() == "wss",
        Err(_) => false,
    }
}

fn is_link(account: &StoredHostAccount) -> bool {
    !account.server_origin.is_empty() && is_key(&account.host_id)
}

/// `parseStoredHost`, typed: the keychain record comes back through here
/// before `PinomadClient::connect`. A malformed `account` link or endpoint
/// set is dropped, matching the reference (it costs the field, not the
/// pairing).
#[uniffi::export]
pub fn validate_stored_host(host: StoredHost) -> Result<StoredHost, StoredHostError> {
    if !is_host_url(&host.url) {
        return Err(StoredHostError::InvalidUrl);
    }
    if !is_key(&host.host_key) {
        return Err(StoredHostError::InvalidHostKey);
    }
    if !is_key(&host.private_key) {
        return Err(StoredHostError::InvalidPrivateKey);
    }
    let connection_mode = match host.connection_mode.as_deref() {
        None | Some("auto") => None,
        Some("directOnly") => Some("directOnly".to_string()),
        Some("relayOnly") => Some("relayOnly".to_string()),
        Some(_) => None,
    };
    Ok(StoredHost {
        // Like the reference parse: an empty name is no name.
        name: host.name.filter(|name| !name.is_empty()),
        account: host.account.filter(is_link),
        endpoint_set: host
            .endpoint_set
            .as_ref()
            .and_then(EndpointSet::to_core)
            .map(|set| EndpointSet::from_core(&set)),
        connection_mode,
        rtc_signal_only: host.rtc_signal_only.filter(|hint| *hint),
        ..host
    })
}

/// Why a `PinomadClient` constructor failed.
#[derive(Debug, uniffi::Error)]
pub enum ClientError {
    /// The pasted/scanned link did not parse.
    InvalidPairingLink,
    /// A stored record no longer passes validation.
    InvalidStoredHost { message: String },
    /// Key material or channel setup failed (bad keys, crypto init).
    KeyMaterial { message: String },
    /// The platform passed a local or STUN address that is not `IP:port`.
    RtcAddress { message: String },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::InvalidPairingLink => f.write_str("not a valid pairing link"),
            ClientError::InvalidStoredHost { message } => f.write_str(message),
            ClientError::KeyMaterial { message } => f.write_str(message),
            ClientError::RtcAddress { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for ClientError {}
