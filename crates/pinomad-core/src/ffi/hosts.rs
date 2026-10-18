// Stored-host records at the boundary: the keychain keeps a Codable of
// `StoredHost`; `validate_stored_host` re-checks what the platform read
// back before it builds a connection (same rules as `parse_stored_host`).

use crate::b64::from_base64url;

/// A pairing link's destination: the socket URL and the host's key
/// (base64url, as `StoredHost.host_key`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PairingTarget {
    pub url: String,
    pub host_key: String,
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
    /// `ws://` or `wss://` socket URL.
    pub url: String,
    /// base64url of the host's 32-byte Noise static key.
    pub host_key: String,
    /// base64url of this device's 32-byte Noise private key.
    pub private_key: String,
    /// Account binding; a malformed stored link drops it, not the pairing.
    pub account: Option<StoredHostAccount>,
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
    from_base64url(text).map(|bytes| bytes.len() == 32).unwrap_or(false)
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
/// before `PinomadClient::connect`. A malformed `account` link is dropped,
/// matching the reference (it costs the association, not the pairing).
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
    Ok(StoredHost {
        account: host.account.filter(is_link),
        ..host
    })
}

/// Why a `PinomadClient` constructor failed.
#[derive(Debug, uniffi::Error)]
pub enum ClientError {
    /// The pasted/scanned link did not parse.
    InvalidPairingLink,
    /// Key material or channel setup failed (bad keys, crypto init).
    KeyMaterial { message: String },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::InvalidPairingLink => f.write_str("not a valid pairing link"),
            ClientError::KeyMaterial { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for ClientError {}
