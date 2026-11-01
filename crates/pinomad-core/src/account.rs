// The server-accounts API (ADR-0022; apps/site/content/docs/remote-access.zh.md "服务端账号") as a
// client sees it — `packages/client/src/account.ts` with the transport lifted
// out (ADR-0024 §3): `account_request` builds the HTTP the platform sends
// verbatim, `account_response` turns the status+body it gets back into typed
// values. Only bearer mode exists here — the cookie mode is browser-only.
//
// A request that never gets an answer (DNS failure, timeout, aborted socket)
// never reaches `account_response` — the platform reports `code: "network"`
// itself, like the reference's fetch seam does.

use std::collections::HashSet;
use std::sync::Arc;

use url::{Host, Url};

use crate::endpoints::{parse_endpoint_set, EndpointSet, ParsedEndpointSet};
use crate::frames::ApnsPushToken;
use crate::json::{number_to_json, Json, JsonObject};
use crate::pairing_link::encode_uri_component;
use crate::stored_host::StoredHost;
use crate::u16str::U16String;

// ─── Requests ───────────────────────────────────────────────────────────────

/// This install's claim at login (ADR-0037 §1): the random id it generated
/// once and keeps — 22–64 base64url characters, or the server answers 400 —
/// plus an optional label.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountDeviceClaim {
    pub id: String,
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub name: Option<String>,
}

/// One account call. `Login` carries the submitted credentials and, when
/// the platform has one, its device claim (ADR-0037 §1);
/// `RequestPairing` carries the account-bound hostId; the push-token pair
/// carries this device's APNs token (ADR-0036); `ChangePassword` carries
/// both passwords (#450); `DeleteAccount` and `KickDevice` carry the
/// password again (#451, ADR-0037 §3), `KickDevice` also the server's id
/// from `ListDevices`.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountOp {
    Login {
        username: String,
        password: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        device: Option<AccountDeviceClaim>,
    },
    Me,
    /// `revoke` also takes this device off every host it joined through
    /// the account (#494); off, the request is the plain sign-out.
    Logout {
        #[cfg_attr(feature = "ffi", uniffi(default = false))]
        revoke: bool,
    },
    RevokeAllSessions,
    CreateJoinToken,
    ListHosts,
    RequestPairing { host_id: String },
    RegisterPushToken { token: ApnsPushToken },
    RemovePushToken { token: ApnsPushToken },
    ChangePassword { current_password: String, new_password: String },
    DeleteAccount { password: String },
    ListDevices,
    KickDevice { id: f64, password: String },
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
    RegisterPushToken,
    RemovePushToken,
    ChangePassword,
    DeleteAccount,
    ListDevices,
    KickDevice,
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
            AccountOp::Logout { .. } => AccountOpKind::Logout,
            AccountOp::RevokeAllSessions => AccountOpKind::RevokeAllSessions,
            AccountOp::CreateJoinToken => AccountOpKind::CreateJoinToken,
            AccountOp::ListHosts => AccountOpKind::ListHosts,
            AccountOp::RequestPairing { .. } => AccountOpKind::RequestPairing,
            AccountOp::RegisterPushToken { .. } => AccountOpKind::RegisterPushToken,
            AccountOp::RemovePushToken { .. } => AccountOpKind::RemovePushToken,
            AccountOp::ChangePassword { .. } => AccountOpKind::ChangePassword,
            AccountOp::DeleteAccount { .. } => AccountOpKind::DeleteAccount,
            AccountOp::ListDevices => AccountOpKind::ListDevices,
            AccountOp::KickDevice { .. } => AccountOpKind::KickDevice,
        }
    }

    fn method(&self) -> &'static str {
        match self {
            AccountOp::Me | AccountOp::ListHosts | AccountOp::ListDevices => "GET",
            _ => "POST",
        }
    }

    fn path(&self) -> String {
        match self {
            AccountOp::Login { .. } => "/api/login".to_string(),
            AccountOp::Me => "/api/me".to_string(),
            AccountOp::Logout { .. } => "/api/logout".to_string(),
            AccountOp::RevokeAllSessions => "/api/sessions/revoke-all".to_string(),
            AccountOp::CreateJoinToken => "/api/join-tokens".to_string(),
            AccountOp::ListHosts => "/api/hosts".to_string(),
            // `encodeURIComponent(hostId)` — a hostId is a key-like token, but
            // the reference encodes it regardless.
            AccountOp::RequestPairing { host_id } => {
                format!("/api/hosts/{}/pairing", encode_uri_component(host_id))
            }
            AccountOp::RegisterPushToken { .. } => "/api/push-tokens".to_string(),
            AccountOp::RemovePushToken { .. } => "/api/push-tokens/remove".to_string(),
            AccountOp::ChangePassword { .. } => "/api/password".to_string(),
            AccountOp::DeleteAccount { .. } => "/api/me/delete".to_string(),
            AccountOp::ListDevices => "/api/devices".to_string(),
            // `${id}` — the number as JS prints it.
            AccountOp::KickDevice { id, .. } => format!("/api/devices/{}/kick", number_to_json(*id)),
        }
    }

    /// `JSON.stringify(body)`, byte-identical to the reference's literal
    /// order: `{username, password, device?: {id, name?}}` for login, `{apns, environment}` for the
    /// push-token pair — the token stays out of the URL —
    /// `{currentPassword, newPassword}` for a password change, and
    /// `{password}` for deleting the account or kicking a device, and
    /// `{revoke: true}` for a revoking sign-out.
    fn body(&self) -> Option<String> {
        match self {
            AccountOp::Login { username, password, device } => {
                let mut object = JsonObject::new();
                object.set(U16String::from_str("username"), Json::from(username.as_str()));
                object.set(U16String::from_str("password"), Json::from(password.as_str()));
                if let Some(device) = device {
                    let mut claim = JsonObject::new();
                    claim.set(U16String::from_str("id"), Json::from(device.id.as_str()));
                    if let Some(name) = &device.name {
                        claim.set(U16String::from_str("name"), Json::from(name.as_str()));
                    }
                    object.set(U16String::from_str("device"), Json::Object(Arc::new(claim)));
                }
                Some(Json::Object(Arc::new(object)).to_json())
            }
            AccountOp::RegisterPushToken { token } | AccountOp::RemovePushToken { token } => {
                let mut object = JsonObject::new();
                object.set(U16String::from_str("apns"), Json::from(token.apns.as_str()));
                object.set(U16String::from_str("environment"), Json::from(token.environment.as_str()));
                Some(Json::Object(Arc::new(object)).to_json())
            }
            AccountOp::ChangePassword { current_password, new_password } => {
                let mut object = JsonObject::new();
                object.set(U16String::from_str("currentPassword"), Json::from(current_password.as_str()));
                object.set(U16String::from_str("newPassword"), Json::from(new_password.as_str()));
                Some(Json::Object(Arc::new(object)).to_json())
            }
            AccountOp::DeleteAccount { password } | AccountOp::KickDevice { password, .. } => {
                let mut object = JsonObject::new();
                object.set(U16String::from_str("password"), Json::from(password.as_str()));
                Some(Json::Object(Arc::new(object)).to_json())
            }
            AccountOp::Logout { revoke: true } => {
                let mut object = JsonObject::new();
                object.set(U16String::from_str("revoke"), Json::Bool(true));
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
    /// The server's admin account (#449) — only a literal `true` counts.
    #[cfg_attr(feature = "ffi", uniffi(default = false))]
    pub admin: bool,
    pub expires_at: f64,
    pub token: Option<String>,
}

/// `GET /api/me` — the user, and whether it is the server's admin (#449).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountMe {
    pub user: AccountUser,
    #[cfg_attr(feature = "ffi", uniffi(default = false))]
    pub admin: bool,
}

/// One account device's standing on a host it joined through the account
/// (ADR-0037 §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountDeviceHostState {
    Registered,
    /// The server asked the host to revoke it and the host hasn't confirmed.
    Revoking,
    Revoked,
}

impl AccountDeviceHostState {
    /// The wire string the reference uses.
    pub fn as_str(&self) -> &'static str {
        match self {
            AccountDeviceHostState::Registered => "registered",
            AccountDeviceHostState::Revoking => "revoking",
            AccountDeviceHostState::Revoked => "revoked",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountDeviceHost {
    pub host_id: String,
    pub name: String,
    pub state: AccountDeviceHostState,
}

/// One row of `GET /api/devices` (#452).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountDevice {
    /// The server's id, which `KickDevice` takes — not the claim's own id.
    pub id: f64,
    /// Absent for clients that never said (older apps, sessions from before #452).
    pub name: Option<String>,
    pub created_at: f64,
    pub last_seen_at: f64,
    /// The device whose session made this request.
    pub current: bool,
    pub kicked_at: Option<f64>,
    pub hosts: Vec<AccountDeviceHost>,
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
    /// As of the host's latest register: `Some(false)` means the server can't
    /// ask it to revoke a device (ADR-0037 §5). `None` from older servers.
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub device_reports: Option<bool>,
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
    Me(AccountMe),
    /// `logout`, `revokeAllSessions`, the push-token pair, `changePassword`,
    /// `deleteAccount` and `kickDevice` answer nothing.
    Unit,
    JoinToken(JoinToken),
    Hosts(Vec<AccountHost>),
    Devices(Vec<AccountDevice>),
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

/// `value.admin === true`.
fn admin_flag(value: &Json) -> bool {
    matches!(value.get("admin"), Some(Json::Bool(true)))
}

/// An optional member: absent is `None`, present but not a number is malformed.
fn optional_num(value: &Json, key: &str) -> Result<Option<f64>, AccountError> {
    match value.get(key) {
        None => Ok(None),
        Some(Json::Number(n)) => Ok(Some(*n)),
        Some(_) => Err(AccountError::invalid()),
    }
}

/// `isDevice` — any member of the wrong type, or a host state outside the
/// three, makes the whole list `invalid_response`.
fn decode_device(entry: &Json) -> Result<AccountDevice, AccountError> {
    let name = match entry.get("name") {
        None => None,
        Some(Json::String(name)) => Some(name.to_string_lossy()),
        Some(_) => return Err(AccountError::invalid()),
    };
    let current = match entry.get("current") {
        Some(Json::Bool(current)) => *current,
        _ => return Err(AccountError::invalid()),
    };
    let entries = entry.get("hosts").and_then(Json::as_array).ok_or_else(AccountError::invalid)?;
    let mut hosts = Vec::with_capacity(entries.len());
    for host in entries.iter() {
        hosts.push(AccountDeviceHost {
            host_id: str_field(host, "hostId").ok_or_else(AccountError::invalid)?,
            name: str_field(host, "name").ok_or_else(AccountError::invalid)?,
            state: match str_field(host, "state").as_deref() {
                Some("registered") => AccountDeviceHostState::Registered,
                Some("revoking") => AccountDeviceHostState::Revoking,
                Some("revoked") => AccountDeviceHostState::Revoked,
                _ => return Err(AccountError::invalid()),
            },
        });
    }
    Ok(AccountDevice {
        id: num_field(entry, "id").ok_or_else(AccountError::invalid)?,
        name,
        created_at: num_field(entry, "createdAt").ok_or_else(AccountError::invalid)?,
        last_seen_at: num_field(entry, "lastSeenAt").ok_or_else(AccountError::invalid)?,
        current,
        kicked_at: optional_num(entry, "kickedAt")?,
        hosts,
    })
}

/// The endpoint's own shape check on a parsed 2xx body (`None` = a body that
/// didn't parse or never arrived).
fn decode_value(kind: AccountOpKind, value: Option<&Json>) -> Result<AccountValue, AccountError> {
    let value = value.unwrap_or(&Json::Null);
    match kind {
        AccountOpKind::Login => Ok(AccountValue::Login(LoginSuccess {
            user: user_body(value).ok_or_else(AccountError::invalid)?,
            admin: admin_flag(value),
            expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
            token: str_field(value, "token"),
        })),
        AccountOpKind::Me => Ok(AccountValue::Me(AccountMe {
            user: user_body(value).ok_or_else(AccountError::invalid)?,
            admin: admin_flag(value),
        })),
        // `result.ok ? ok(undefined)` — any 2xx answers the void ops.
        AccountOpKind::Logout
        | AccountOpKind::RevokeAllSessions
        | AccountOpKind::RegisterPushToken
        | AccountOpKind::RemovePushToken
        | AccountOpKind::ChangePassword
        | AccountOpKind::DeleteAccount
        | AccountOpKind::KickDevice => Ok(AccountValue::Unit),
        AccountOpKind::ListDevices => {
            let entries = value.as_array().ok_or_else(AccountError::invalid)?;
            Ok(AccountValue::Devices(entries.iter().map(decode_device).collect::<Result<_, _>>()?))
        }
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
                    device_reports: match entry.get("deviceReports") {
                        None => None,
                        Some(Json::Bool(reports)) => Some(*reports),
                        Some(_) => return Err(AccountError::invalid()),
                    },
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

/// One account-host identity: the server that vouches for it plus its hostId.
/// The declined set stores these so a forgotten or refused account host is not
/// silently registered again.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountHostRef {
    pub server_origin: String,
    pub host_id: String,
}

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
    /// Whether this client may register the host through the account without
    /// asking the user (M8): only an unpaired host, outside the declined set,
    /// when the local pairing list was actually read. A failed read is not an
    /// empty list.
    pub auto_register: bool,
}

/// Pair the server's account hosts against the device's stored pairings.
/// Identity is the Noise key: a stored entry whose `account` link matches
/// serverOrigin+hostId is paired (or `key_changed` when the keys diverged);
/// an unlinked entry with the same key counts as paired and may adopt the
/// link.
///
/// `declined` holds identities the user forgot or the host refused;
/// `stored_read` is false when the local pairing list could not be loaded,
/// which must not be mistaken for an empty list. Both only affect
/// `auto_register`: the verdict still describes the pairing the client has.
pub fn match_account_hosts(
    server_origin: &str,
    hosts: &[AccountHost],
    stored: &[StoredHost],
    declined: &[AccountHostRef],
    stored_read: bool,
) -> Vec<AccountHostMatch> {
    let origin = normalize_server_origin(server_origin);
    let declined_keys: HashSet<String> = declined
        .iter()
        .map(|entry| format!("{}\u{0}{}", normalize_server_origin(&entry.server_origin), entry.host_id))
        .collect();
    hosts
        .iter()
        .map(|host| {
            let match_for = |status: AccountHostStatus, stored: Option<StoredHost>, linkable: bool| {
                AccountHostMatch {
                    host: host.clone(),
                    status,
                    stored,
                    linkable,
                    auto_register: stored_read
                        && status == AccountHostStatus::Unpaired
                        && !declined_keys.contains(&format!("{origin}\u{0}{}", host.host_id)),
                }
            };
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
                return match_for(AccountHostStatus::Paired, Some((*exact).clone()), false);
            }
            if let Some(first) = linked.first() {
                return match_for(AccountHostStatus::KeyChanged, Some((*first).clone()), false);
            }
            // The twin check does not exclude linked entries — an entry
            // bound elsewhere with the same key still counts as paired.
            if let Some(twin) = stored.iter().find(|entry| entry.host_key == host.noise_public_key) {
                return match_for(AccountHostStatus::Paired, Some(twin.clone()), twin.account.is_none());
            }
            match_for(AccountHostStatus::Unpaired, None, false)
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
