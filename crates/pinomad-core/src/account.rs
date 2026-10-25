// The server-accounts API (ADR-0022; docs/remote-access.md "服务端账号") as a
// client sees it — `packages/client/src/account.ts` with the transport lifted
// out (ADR-0024 §3): `account_request` builds the HTTP the platform sends
// verbatim, `account_response` turns the status+body it gets back into typed
// values. Only bearer mode exists here — the cookie mode is browser-only.
//
// A request that never gets an answer (DNS failure, timeout, aborted socket)
// never reaches `account_response` — the platform reports `code: "network"`
// itself, like the reference's fetch seam does.

use std::sync::Arc;

use url::{Host, Url};

use crate::endpoints::{parse_endpoint_set, EndpointSet, ParsedEndpointSet};
use crate::json::{Json, JsonObject};
use crate::pairing_link::encode_uri_component;
use crate::stored_host::StoredHost;
use crate::u16str::U16String;

// ─── Requests ───────────────────────────────────────────────────────────────

/// One account call. `Login` carries the submitted credentials;
/// `RequestPairing` carries the account-bound hostId.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountOp {
    Login { username: String, password: String },
    Me,
    Logout,
    RevokeAllSessions,
    CreateJoinToken,
    ListHosts,
    RequestPairing { host_id: String },
}

/// Which endpoint an answer belongs to — `account_response` picks its shape
/// check from this, so the platform doesn't resend the op's payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountOpKind {
    Login,
    Me,
    Logout,
    RevokeAllSessions,
    CreateJoinToken,
    ListHosts,
    RequestPairing,
}

/// One header on the request the platform sends, in the reference's order.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountHttpHeader {
    pub name: String,
    pub value: String,
}

/// The HTTP request the platform sends as-is: `method` on `url` with
/// `headers` in order, then `body` when present.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountHttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<AccountHttpHeader>,
    pub body: Option<String>,
}

impl AccountOp {
    /// The discriminant `account_response` reads the answer by.
    pub fn kind(&self) -> AccountOpKind {
        match self {
            AccountOp::Login { .. } => AccountOpKind::Login,
            AccountOp::Me => AccountOpKind::Me,
            AccountOp::Logout => AccountOpKind::Logout,
            AccountOp::RevokeAllSessions => AccountOpKind::RevokeAllSessions,
            AccountOp::CreateJoinToken => AccountOpKind::CreateJoinToken,
            AccountOp::ListHosts => AccountOpKind::ListHosts,
            AccountOp::RequestPairing { .. } => AccountOpKind::RequestPairing,
        }
    }

    fn method(&self) -> &'static str {
        match self {
            AccountOp::Me | AccountOp::ListHosts => "GET",
            _ => "POST",
        }
    }

    fn path(&self) -> String {
        match self {
            AccountOp::Login { .. } => "/api/login".to_string(),
            AccountOp::Me => "/api/me".to_string(),
            AccountOp::Logout => "/api/logout".to_string(),
            AccountOp::RevokeAllSessions => "/api/sessions/revoke-all".to_string(),
            AccountOp::CreateJoinToken => "/api/join-tokens".to_string(),
            AccountOp::ListHosts => "/api/hosts".to_string(),
            // `encodeURIComponent(hostId)` — a hostId is a key-like token, but
            // the reference encodes it regardless.
            AccountOp::RequestPairing { host_id } => {
                format!("/api/hosts/{}/pairing", encode_uri_component(host_id))
            }
        }
    }

    /// `JSON.stringify(body)` — only login carries one, byte-identical to the
    /// reference's `{username, password}` literal order.
    fn body(&self) -> Option<String> {
        match self {
            AccountOp::Login { username, password } => {
                let mut object = JsonObject::new();
                object.set(U16String::from_str("username"), Json::from(username.as_str()));
                object.set(U16String::from_str("password"), Json::from(password.as_str()));
                Some(Json::Object(Arc::new(object)).to_json())
            }
            _ => None,
        }
    }
}

/// `request()` in the reference's bearer mode, minus the fetch: the
/// normalized origin plus the op's path, `Authorization: Bearer` when a
/// token exists, `content-type: application/json` when a body does.
pub fn account_request(origin: &str, token: Option<&str>, op: &AccountOp) -> AccountHttpRequest {
    let body = op.body();
    let mut headers = Vec::new();
    if let Some(token) = token {
        headers.push(AccountHttpHeader {
            name: "authorization".to_string(),
            value: format!("Bearer {token}"),
        });
    }
    if body.is_some() {
        headers.push(AccountHttpHeader {
            name: "content-type".to_string(),
            value: "application/json".to_string(),
        });
    }
    AccountHttpRequest {
        method: op.method().to_string(),
        url: format!("{}{}", normalize_server_origin(origin), op.path()),
        headers,
        body,
    }
}

/// The probe's request: `GET {origin}/api/me`. `probeAccounts` strips
/// trailing slashes but does NOT canonicalize the origin — it probes the
/// address the user typed, not the normalized form the client keeps.
pub fn account_probe_request(origin: &str) -> AccountHttpRequest {
    AccountHttpRequest {
        method: "GET".to_string(),
        url: format!("{}/api/me", origin.trim_end_matches('/')),
        headers: Vec::new(),
        body: None,
    }
}

// ─── Answers ────────────────────────────────────────────────────────────────

/// The signed-in user as `me`/`login` report it.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountUser {
    pub username: String,
}

/// A completed login: the session's expiry in epoch ms, plus the bearer
/// token when the server answered with one (cookie answers carry none).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct LoginSuccess {
    pub user: AccountUser,
    pub expires_at: f64,
    pub token: Option<String>,
}

/// `POST /api/join-tokens` — the one-use token and the ready-to-show
/// `pinomad join …` command.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct JoinToken {
    pub token: String,
    pub expires_at: f64,
    pub command: String,
}

/// The server-side verdict on whether a pairing ask can reach this host
/// right now (`GET /api/hosts`'s `pairing` field).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountHostPairing {
    Available,
    Offline,
    HostTooOld,
    KeyMismatch,
}

impl AccountHostPairing {
    /// The wire string the reference uses.
    pub fn as_str(&self) -> &'static str {
        match self {
            AccountHostPairing::Available => "available",
            AccountHostPairing::Offline => "offline",
            AccountHostPairing::HostTooOld => "host_too_old",
            AccountHostPairing::KeyMismatch => "key_mismatch",
        }
    }
}

/// One account-bound host row as `GET /api/hosts` reports it.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountHost {
    pub host_id: String,
    pub name: String,
    /// The host's Noise public key — the pairing identity.
    pub noise_public_key: String,
    pub online: bool,
    /// Epoch ms of the last register heartbeat.
    pub last_seen_at: f64,
    pub pairing: AccountHostPairing,
}

/// The answer to `POST /api/hosts/:hostId/pairing` — the vouched one-time
/// offer `account_pairing_link` turns into a pairing link.
#[derive(Clone, Debug, PartialEq)]
pub struct PairingOffer {
    /// The ws:/wss: socket the pairing handshake dials (legacy fallback).
    pub url: String,
    /// base64url of the host's 32-byte Noise static key.
    pub host_key: String,
    /// The one-use pairing secret.
    pub secret: String,
    /// Epoch ms the offer dies.
    pub expires_at: f64,
    /// The offer's remote candidates. Absent for old servers; a malformed or
    /// explicitly empty set is `invalid_response` (ADR-0032).
    pub endpoint_set: Option<EndpointSet>,
}

/// The decoded success payload — which variant answers which op is fixed.
#[derive(Clone, Debug, PartialEq)]
pub enum AccountValue {
    Login(LoginSuccess),
    /// `me` — just the user.
    Me(AccountUser),
    /// `logout` and `revokeAllSessions` answer nothing.
    Unit,
    JoinToken(JoinToken),
    Hosts(Vec<AccountHost>),
    PairingOffer(PairingOffer),
}

/// An API failure the UI maps straight to copy. `code` is the server's
/// `error` verbatim — invalid_credentials, rate_limited, host_offline,
/// host_too_old, key_mismatch, disabled, not_joined, rebinding,
/// host_timeout, unauthenticated, accounts_disabled, not_found, and friends
/// — plus `unknown` (a non-2xx without a code) and `invalid_response` (a 2xx
/// that didn't match the endpoint's shape; `status` is absent there). The
/// core never invents `network` — a request with no answer is the platform
/// layer's to report.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Error))]
pub enum AccountError {
    Api { code: String, status: Option<u16> },
}

impl AccountError {
    fn invalid() -> Self {
        AccountError::Api {
            code: "invalid_response".to_string(),
            status: None,
        }
    }
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AccountError::Api { code, status } => match status {
                Some(status) => write!(f, "{code} ({status})"),
                None => f.write_str(code),
            },
        }
    }
}

impl std::error::Error for AccountError {}

/// `typeof value === "string"` on a member — absent/wrong-type is None.
fn str_field(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(|s| s.to_string_lossy())
}

fn num_field(value: &Json, key: &str) -> Option<f64> {
    value.get(key).and_then(Json::as_number)
}

/// `{user: {username}}` — everything else in the object is dropped, like the
/// reference's fresh `{user: {username}}` result.
fn user_body(value: &Json) -> Option<AccountUser> {
    // `isRecord(v)` lets arrays through in JS, but an array's `.user` reads
    // as undefined either way — `get` on a non-object misses identically.
    let username = value.get("user")?.get("username").and_then(Json::as_str)?;
    Some(AccountUser {
        username: username.to_string_lossy(),
    })
}

/// The endpoint's own shape check on a parsed 2xx body (`None` = a body that
/// didn't parse or never arrived).
fn decode_value(kind: AccountOpKind, value: Option<&Json>) -> Result<AccountValue, AccountError> {
    let value = value.unwrap_or(&Json::Null);
    match kind {
        AccountOpKind::Login => Ok(AccountValue::Login(LoginSuccess {
            user: user_body(value).ok_or_else(AccountError::invalid)?,
            expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
            token: str_field(value, "token"),
        })),
        AccountOpKind::Me => Ok(AccountValue::Me(user_body(value).ok_or_else(AccountError::invalid)?)),
        // `result.ok ? ok(undefined)` — any 2xx answers the void ops.
        AccountOpKind::Logout | AccountOpKind::RevokeAllSessions => Ok(AccountValue::Unit),
        AccountOpKind::CreateJoinToken => Ok(AccountValue::JoinToken(JoinToken {
            token: str_field(value, "token").ok_or_else(AccountError::invalid)?,
            expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
            command: str_field(value, "command").ok_or_else(AccountError::invalid)?,
        })),
        AccountOpKind::ListHosts => {
            let entries = value.as_array().ok_or_else(AccountError::invalid)?;
            let mut hosts = Vec::with_capacity(entries.len());
            for entry in entries.iter() {
                let pairing = match str_field(entry, "pairing").as_deref() {
                    Some("available") => AccountHostPairing::Available,
                    Some("offline") => AccountHostPairing::Offline,
                    Some("host_too_old") => AccountHostPairing::HostTooOld,
                    Some("key_mismatch") => AccountHostPairing::KeyMismatch,
                    _ => return Err(AccountError::invalid()),
                };
                hosts.push(AccountHost {
                    host_id: str_field(entry, "hostId").ok_or_else(AccountError::invalid)?,
                    name: str_field(entry, "name").ok_or_else(AccountError::invalid)?,
                    noise_public_key: str_field(entry, "noisePublicKey").ok_or_else(AccountError::invalid)?,
                    online: match entry.get("online") {
                        Some(Json::Bool(online)) => *online,
                        _ => return Err(AccountError::invalid()),
                    },
                    last_seen_at: num_field(entry, "lastSeenAt").ok_or_else(AccountError::invalid)?,
                    pairing,
                });
            }
            Ok(AccountValue::Hosts(hosts))
        }
        AccountOpKind::RequestPairing => {
            let endpoint_set = match value.get("endpointSet") {
                None => None,
                Some(raw) => match parse_endpoint_set(Some(raw)) {
                    ParsedEndpointSet::Valid(set) if !set.endpoints.is_empty() => Some(set),
                    ParsedEndpointSet::Valid(_) | ParsedEndpointSet::Malformed => {
                        return Err(AccountError::invalid())
                    }
                    ParsedEndpointSet::Unsupported | ParsedEndpointSet::Absent => None,
                },
            };
            Ok(AccountValue::PairingOffer(PairingOffer {
                url: str_field(value, "url").ok_or_else(AccountError::invalid)?,
                host_key: str_field(value, "hostKey").ok_or_else(AccountError::invalid)?,
                secret: str_field(value, "secret").ok_or_else(AccountError::invalid)?,
                expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
                endpoint_set,
            }))
        }
    }
}

/// `request()`'s answer half plus the endpoint's shape check: on 2xx the
/// body must fit the op's value shape (else `invalid_response`, no status);
/// on any other status the server's `error` string passes through verbatim,
/// falling back to `unauthenticated` for 401 and `unknown` otherwise — a
/// body that isn't JSON (including an empty one, like a 204's) reads as no
/// body at all.
pub fn account_response(kind: AccountOpKind, status: u16, body: &str) -> Result<AccountValue, AccountError> {
    let json = Json::parse(body).ok();
    if (200..300).contains(&status) {
        return decode_value(kind, json.as_ref());
    }
    let code = json
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .unwrap_or_else(|| (if status == 401 { "unauthenticated" } else { "unknown" }).to_string());
    Err(AccountError::Api {
        code,
        status: Some(status),
    })
}

// ─── Probe ──────────────────────────────────────────────────────────────────

/// Whether a server origin runs accounts — the verdicts the host CLI shares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountsProbe {
    Enabled,
    Disabled,
    Unreachable,
}

impl AccountsProbe {
    pub fn as_str(&self) -> &'static str {
        match self {
            AccountsProbe::Enabled => "enabled",
            AccountsProbe::Disabled => "disabled",
            AccountsProbe::Unreachable => "unreachable",
        }
    }
}

/// The verdict for an `account_probe_request` that already ran. `status` is
/// `None` when no response arrived (network failure or the 5-second probe
/// timeout — the platform owns that timer, body read included); `body` is
/// `None` when a 200's headers arrived but the body never finished inside
/// the timeout — a half-dead proxy is `Unreachable`, not `Disabled`.
pub fn probe_verdict(status: Option<u16>, body: Option<&str>) -> AccountsProbe {
    match status {
        // /api/me asking for a session means the account API exists.
        Some(401) => AccountsProbe::Enabled,
        Some(200) => match body {
            // Headers without a body — a half-dead proxy — can't be told
            // apart from a dead one.
            None => AccountsProbe::Unreachable,
            Some(text) => match Json::parse(text) {
                // `typeof user === "object" && user !== null` — an array
                // counts, like the reference's record check.
                Ok(json) if json.get("user").is_some_and(Json::is_container) => AccountsProbe::Enabled,
                // A fully-read body that isn't JSON — an SPA's index.html —
                // is a plain "disabled".
                _ => AccountsProbe::Disabled,
            },
        },
        Some(404) => AccountsProbe::Disabled,
        _ => AccountsProbe::Unreachable,
    }
}

// ─── Origins ────────────────────────────────────────────────────────────────

/// `new URL().origin`: canonical comparison form — lowercase host, default
/// port gone, trailing slashes gone. Input that won't parse survives
/// verbatim minus trailing slashes, like the reference's catch.
pub fn normalize_server_origin(origin: &str) -> String {
    match Url::parse(origin) {
        // url's WHATWG origins serialize like the browser's — "null" for the
        // opaque ones (data:, non-special schemes).
        Ok(url) => url.origin().ascii_serialization(),
        Err(_) => origin.trim_end_matches('/').to_string(),
    }
}

/// Account traffic is TLS-only (ADR-0022): a plaintext login or join would
/// hand a bearer or one-use token to anyone on the path. Loopback http stays
/// for local development — the same rule the host CLI applies.
pub fn is_secure_server_origin(origin: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let loopback = match url.host() {
        // WHATWG parsing already canonicalized every IPv4 spelling (`127.1`,
        // `0x7f.1`, `2130706433`) into a real address — a `127.example.com`
        // domain no longer slips through a string prefix.
        Some(Host::Ipv4(addr)) => addr.is_loopback(),
        // `::1` only: an IPv4-mapped `[::ffff:127.0.0.1]` does reach loopback
        // on the wire, but the reference can't see it back — both sides call
        // it non-loopback rather than let the verdicts drift.
        Some(Host::Ipv6(addr)) => addr.is_loopback(),
        // `localhost.` keeps its trailing dot after parsing and matches
        // neither branch — refused, conservatively.
        Some(Host::Domain(domain)) => domain == "localhost" || domain.ends_with(".localhost"),
        None => false,
    };
    url.scheme() == "https" || (url.scheme() == "http" && loopback)
}

// ─── Stored-host matching ───────────────────────────────────────────────────

/// How an account-bound host relates to the pairings this device stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountHostStatus {
    /// A stored entry connects to it — linked by account, or sharing the
    /// Noise key.
    Paired,
    /// Nothing stored under it; an invite can be asked for (subject to
    /// `host.pairing`).
    Unpaired,
    /// A stored entry links this serverOrigin+hostId but pins a different
    /// Noise key: the host's key changed (reinstall, or worse). Report only —
    /// never re-pair on the client's own initiative.
    KeyChanged,
}

impl AccountHostStatus {
    /// The wire string the reference uses.
    pub fn as_str(&self) -> &'static str {
        match self {
            AccountHostStatus::Paired => "paired",
            AccountHostStatus::Unpaired => "unpaired",
            AccountHostStatus::KeyChanged => "key_changed",
        }
    }
}

/// One `matchAccountHosts` verdict.
#[derive(Clone, Debug)]
pub struct AccountHostMatch {
    pub host: AccountHost,
    pub status: AccountHostStatus,
    /// The stored pairing behind a `Paired`/`KeyChanged` verdict.
    pub stored: Option<StoredHost>,
    /// The stored entry shares the Noise key but was saved before account
    /// linkage existed — the caller may persist `{...stored, account}` to
    /// adopt the association. False when the match already carries the link.
    pub linkable: bool,
}

/// Pair the server's account hosts against the device's stored pairings.
/// Identity is the Noise key: a stored entry whose `account` link matches
/// serverOrigin+hostId is paired (or `key_changed` when the keys diverged);
/// an unlinked entry with the same key counts as paired and may adopt the
/// link.
pub fn match_account_hosts(
    server_origin: &str,
    hosts: &[AccountHost],
    stored: &[StoredHost],
) -> Vec<AccountHostMatch> {
    let origin = normalize_server_origin(server_origin);
    hosts
        .iter()
        .map(|host| {
            // Several entries may share a link — an explicit re-pair after a
            // key change stores a fresh record without deleting the stale
            // one. The entry whose key still matches wins; only a link with
            // no matching key at all is a key_changed report.
            let linked: Vec<&StoredHost> = stored
                .iter()
                .filter(|entry| {
                    entry.account.as_ref().is_some_and(|account| {
                        normalize_server_origin(&account.server_origin) == origin
                            && account.host_id == host.host_id
                    })
                })
                .collect();
            if let Some(exact) = linked.iter().find(|entry| entry.host_key == host.noise_public_key) {
                return AccountHostMatch {
                    host: host.clone(),
                    status: AccountHostStatus::Paired,
                    stored: Some((*exact).clone()),
                    linkable: false,
                };
            }
            if let Some(first) = linked.first() {
                return AccountHostMatch {
                    host: host.clone(),
                    status: AccountHostStatus::KeyChanged,
                    stored: Some((*first).clone()),
                    linkable: false,
                };
            }
            // The twin check does not exclude linked entries — an entry
            // bound elsewhere with the same key still counts as paired.
            if let Some(twin) = stored.iter().find(|entry| entry.host_key == host.noise_public_key) {
                return AccountHostMatch {
                    host: host.clone(),
                    status: AccountHostStatus::Paired,
                    stored: Some(twin.clone()),
                    linkable: twin.account.is_none(),
                };
            }
            AccountHostMatch {
                host: host.clone(),
                status: AccountHostStatus::Unpaired,
                stored: None,
                linkable: false,
            }
        })
        .collect()
}

// ─── Pairing offers ─────────────────────────────────────────────────────────

/// `accountPairingFragment`: the offer as a `pinomad://pair#pair=…&url=…`
/// link the existing pair flow consumes (`pairing_target`,
/// `PinomadClient::pair`). The fragment is normalized through the same
/// `pairing_fragment` rule pasted links go through, so a malformed offer is
/// refused before a socket opens — `None`, which the platform reports as
/// `invalid_offer` like `pairViaAccount` does.
pub fn account_pairing_link(offer: &PairingOffer) -> Option<String> {
    let mut pasted = format!(
        "https://server.invalid/#pair={}.{}&url={}",
        offer.host_key,
        offer.secret,
        encode_uri_component(&offer.url)
    );
    if let Some(set) = &offer.endpoint_set {
        pasted.push_str("&endpointSet=");
        pasted.push_str(&encode_uri_component(&set.to_json().to_json()));
    }
    crate::pairing_link::pairing_fragment(&pasted).map(|fragment| format!("pinomad://pair#{fragment}"))
}
