// The server-accounts API (ADR-0022; apps/site/content/docs/remote-access.zh.md "服务端账号") as a
// client sees it — `packages/client/src/account.ts` with the transport lifted
// out (ADR-0024 §3): `account_request` builds the HTTP the platform sends
// verbatim, `account_response` turns the status+body it gets back into typed
// values. Only bearer mode exists here — the cookie mode is browser-only.
// That includes the email ops, provider sign-in, sign-in methods and
// re-auth (ADR-0044), which iOS offers like web and desktop.
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

/// The second check before an action on the account (ADR-0044 §6): the
/// password, or a grant from `Reauth`, which only counts for the session
/// that got it and lapses after five minutes. Never cached by a client: the
/// password goes to the server each time it is typed.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AccountConfirmation {
    Password(String),
    Reauth(String),
}

impl AccountConfirmation {
    /// `{password}` or `{reauth}` — `password_key` names the password's
    /// member (`currentPassword` for a password change).
    fn write(&self, object: &mut JsonObject, password_key: &str) {
        match self {
            AccountConfirmation::Password(password) => {
                object.set(U16String::from_str(password_key), Json::from(password.as_str()))
            }
            AccountConfirmation::Reauth(reauth) => {
                object.set(U16String::from_str("reauth"), Json::from(reauth.as_str()))
            }
        }
    }
}

/// Where a native app's link from settings comes back to (#631):
/// `pinomad://auth` or a loopback listener, with a PKCE challenge and the
/// app's state; the browser returns with a `code` for `CompleteLink` (with
/// the verifier the app kept) or `error=…`.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NativeLinkRedirect {
    pub redirect_uri: String,
    pub code_challenge: String,
    pub state: String,
}

/// What `Reauth` trades for a grant: the password, or a mailed code.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ReauthProof {
    Password(String),
    Code(String),
}

/// One account call. `Login` carries the submitted credentials and, when
/// the platform has one, its device claim (ADR-0037 §1);
/// `RequestPairing` carries the account-bound hostId; the push-token pair
/// carries this device's APNs token (ADR-0036); `ChangePassword`,
/// `DeleteAccount`, `KickDevice`, `RemoveHost`, the email pair,
/// `UnlinkProvider` and `LinkPending` carry a confirmation (#450, #451,
/// ADR-0037 §3, #512, ADR-0044 §6) — a grant on `ChangePassword` also sets a
/// first password; the host-link trio carries the code typed from a host's
/// terminal, verbatim (#495), and the loopback trio the request id from a
/// confirm URL (#513). The rest are ADR-0044's: email sign-up and reset,
/// sign-in methods, re-auth, the pending "no account yet" sign-in, a native
/// provider sign-in's code exchange and iOS's own Sign in with Apple, and
/// linking a provider from settings (#631): through the browser, or
/// Apple's own sheet.
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
    ChangePassword { current: AccountConfirmation, new_password: String },
    DeleteAccount { confirmation: AccountConfirmation },
    ListDevices,
    KickDevice { id: f64, confirmation: AccountConfirmation },
    RemoveHost { host_id: String, confirmation: AccountConfirmation },
    LookupHostLink { user_code: String },
    ConfirmHostLink { user_code: String },
    DenyHostLink { user_code: String },
    LookupHostLinkRequest { request_id: String },
    ConfirmHostLinkRequest { request_id: String },
    DenyHostLinkRequest { request_id: String },
    AuthMethods,
    RequestSignupCode { email: String },
    Register {
        email: String,
        code: String,
        password: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        device: Option<AccountDeviceClaim>,
    },
    RequestPasswordReset { email: String },
    ResetPassword { email: String, code: String, password: String },
    RequestEmailCode { email: String, confirmation: AccountConfirmation },
    SetEmail { email: String, code: String, confirmation: AccountConfirmation },
    Identities,
    UnlinkProvider { provider: String, confirmation: AccountConfirmation },
    RequestReauthCode,
    Reauth { proof: ReauthProof },
    PendingSignIn { id: String },
    CreateFromPending {
        id: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        password: Option<String>,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        device: Option<AccountDeviceClaim>,
    },
    LinkPending { id: String, confirmation: AccountConfirmation },
    ExchangeOAuthCode {
        code: String,
        code_verifier: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        device: Option<AccountDeviceClaim>,
    },
    AppleNative {
        identity_token: String,
        authorization_code: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        nonce: Option<String>,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        name: Option<String>,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        device: Option<AccountDeviceClaim>,
    },
    LinkProvider {
        provider: String,
        confirmation: AccountConfirmation,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        native: Option<NativeLinkRedirect>,
    },
    CompleteLink { code: String, code_verifier: String },
    LinkAppleNative {
        identity_token: String,
        authorization_code: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        nonce: Option<String>,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        name: Option<String>,
        confirmation: AccountConfirmation,
    },
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
    RemoveHost,
    LookupHostLink,
    ConfirmHostLink,
    DenyHostLink,
    LookupHostLinkRequest,
    ConfirmHostLinkRequest,
    DenyHostLinkRequest,
    AuthMethods,
    RequestSignupCode,
    Register,
    RequestPasswordReset,
    ResetPassword,
    RequestEmailCode,
    SetEmail,
    Identities,
    UnlinkProvider,
    RequestReauthCode,
    Reauth,
    PendingSignIn,
    CreateFromPending,
    LinkPending,
    ExchangeOAuthCode,
    AppleNative,
    LinkProvider,
    CompleteLink,
    LinkAppleNative,
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
            AccountOp::RemoveHost { .. } => AccountOpKind::RemoveHost,
            AccountOp::LookupHostLink { .. } => AccountOpKind::LookupHostLink,
            AccountOp::ConfirmHostLink { .. } => AccountOpKind::ConfirmHostLink,
            AccountOp::DenyHostLink { .. } => AccountOpKind::DenyHostLink,
            AccountOp::LookupHostLinkRequest { .. } => AccountOpKind::LookupHostLinkRequest,
            AccountOp::ConfirmHostLinkRequest { .. } => AccountOpKind::ConfirmHostLinkRequest,
            AccountOp::DenyHostLinkRequest { .. } => AccountOpKind::DenyHostLinkRequest,
            AccountOp::AuthMethods => AccountOpKind::AuthMethods,
            AccountOp::RequestSignupCode { .. } => AccountOpKind::RequestSignupCode,
            AccountOp::Register { .. } => AccountOpKind::Register,
            AccountOp::RequestPasswordReset { .. } => AccountOpKind::RequestPasswordReset,
            AccountOp::ResetPassword { .. } => AccountOpKind::ResetPassword,
            AccountOp::RequestEmailCode { .. } => AccountOpKind::RequestEmailCode,
            AccountOp::SetEmail { .. } => AccountOpKind::SetEmail,
            AccountOp::Identities => AccountOpKind::Identities,
            AccountOp::UnlinkProvider { .. } => AccountOpKind::UnlinkProvider,
            AccountOp::RequestReauthCode => AccountOpKind::RequestReauthCode,
            AccountOp::Reauth { .. } => AccountOpKind::Reauth,
            AccountOp::PendingSignIn { .. } => AccountOpKind::PendingSignIn,
            AccountOp::CreateFromPending { .. } => AccountOpKind::CreateFromPending,
            AccountOp::LinkPending { .. } => AccountOpKind::LinkPending,
            AccountOp::ExchangeOAuthCode { .. } => AccountOpKind::ExchangeOAuthCode,
            AccountOp::AppleNative { .. } => AccountOpKind::AppleNative,
            AccountOp::LinkProvider { .. } => AccountOpKind::LinkProvider,
            AccountOp::CompleteLink { .. } => AccountOpKind::CompleteLink,
            AccountOp::LinkAppleNative { .. } => AccountOpKind::LinkAppleNative,
        }
    }

    fn method(&self) -> &'static str {
        match self {
            AccountOp::Me
            | AccountOp::ListHosts
            | AccountOp::ListDevices
            | AccountOp::AuthMethods
            | AccountOp::Identities
            | AccountOp::PendingSignIn { .. } => "GET",
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
            AccountOp::RemoveHost { host_id, .. } => format!("/api/hosts/{}/remove", encode_uri_component(host_id)),
            AccountOp::LookupHostLink { .. } | AccountOp::LookupHostLinkRequest { .. } => {
                "/api/host-link/lookup".to_string()
            }
            AccountOp::ConfirmHostLink { .. } | AccountOp::ConfirmHostLinkRequest { .. } => {
                "/api/host-link/confirm".to_string()
            }
            AccountOp::DenyHostLink { .. } | AccountOp::DenyHostLinkRequest { .. } => {
                "/api/host-link/deny".to_string()
            }
            AccountOp::AuthMethods => "/api/auth/methods".to_string(),
            AccountOp::RequestSignupCode { .. } => "/api/register/code".to_string(),
            AccountOp::Register { .. } => "/api/register".to_string(),
            AccountOp::RequestPasswordReset { .. } => "/api/password/reset/code".to_string(),
            AccountOp::ResetPassword { .. } => "/api/password/reset".to_string(),
            AccountOp::RequestEmailCode { .. } => "/api/me/email/code".to_string(),
            AccountOp::SetEmail { .. } => "/api/me/email".to_string(),
            AccountOp::Identities => "/api/me/identities".to_string(),
            AccountOp::UnlinkProvider { provider, .. } => {
                format!("/api/me/identities/{}/remove", encode_uri_component(provider))
            }
            AccountOp::RequestReauthCode => "/api/reauth/code".to_string(),
            AccountOp::Reauth { .. } => "/api/reauth".to_string(),
            AccountOp::PendingSignIn { id } => format!("/api/oauth/pending/{}", encode_uri_component(id)),
            AccountOp::CreateFromPending { id, .. } => {
                format!("/api/oauth/pending/{}/create", encode_uri_component(id))
            }
            AccountOp::LinkPending { id, .. } => format!("/api/oauth/pending/{}/link", encode_uri_component(id)),
            AccountOp::ExchangeOAuthCode { .. } => "/api/oauth/token".to_string(),
            AccountOp::AppleNative { .. } | AccountOp::LinkAppleNative { .. } => "/api/oauth/apple/native".to_string(),
            AccountOp::CompleteLink { .. } => "/api/oauth/link/complete".to_string(),
            AccountOp::LinkProvider { provider, .. } => format!("/api/oauth/{}/link", encode_uri_component(provider)),
        }
    }

    /// `JSON.stringify(body)`, byte-identical to the reference's literal
    /// order: `{username, password, device?: {id, name?}}` for login, `{apns, environment}` for the
    /// push-token pair — the token stays out of the URL —
    /// `{currentPassword | reauth, newPassword}` for a password change,
    /// `{password | reauth}` for the other confirmed actions,
    /// `{revoke: true}` for a revoking sign-out, `{userCode}` for the
    /// host-link trio and `{requestId}` for the loopback trio; ADR-0044's
    /// ops send their fields in the reference client's order, `{}` when a
    /// POST has nothing to say.
    fn body(&self) -> Option<String> {
        let mut object = JsonObject::new();
        let o = &mut object;
        match self {
            AccountOp::Login { username, password, device } => {
                set_text(o, "username", username);
                set_text(o, "password", password);
                set_device(o, device);
            }
            AccountOp::RegisterPushToken { token } | AccountOp::RemovePushToken { token } => {
                set_text(o, "apns", &token.apns);
                set_text(o, "environment", token.environment.as_str());
            }
            AccountOp::ChangePassword { current, new_password } => {
                current.write(o, "currentPassword");
                o.set(U16String::from_str("newPassword"), Json::from(new_password.as_str()));
            }
            AccountOp::DeleteAccount { confirmation }
            | AccountOp::KickDevice { confirmation, .. }
            | AccountOp::RemoveHost { confirmation, .. }
            | AccountOp::UnlinkProvider { confirmation, .. }
            | AccountOp::LinkPending { confirmation, .. } => confirmation.write(o, "password"),
            AccountOp::LookupHostLink { user_code }
            | AccountOp::ConfirmHostLink { user_code }
            | AccountOp::DenyHostLink { user_code } => set_text(o, "userCode", user_code),
            AccountOp::LookupHostLinkRequest { request_id }
            | AccountOp::ConfirmHostLinkRequest { request_id }
            | AccountOp::DenyHostLinkRequest { request_id } => set_text(o, "requestId", request_id),
            AccountOp::Logout { revoke: true } => o.set(U16String::from_str("revoke"), Json::Bool(true)),
            AccountOp::RequestSignupCode { email } | AccountOp::RequestPasswordReset { email } => set_text(o, "email", email),
            AccountOp::Register { email, code, password, device } => {
                set_text(o, "email", email);
                set_text(o, "code", code);
                set_text(o, "password", password);
                set_device(o, device);
            }
            AccountOp::ResetPassword { email, code, password } => {
                set_text(o, "email", email);
                set_text(o, "code", code);
                set_text(o, "password", password);
            }
            AccountOp::RequestEmailCode { email, confirmation } => {
                set_text(o, "email", email);
                confirmation.write(o, "password");
            }
            AccountOp::SetEmail { email, code, confirmation } => {
                set_text(o, "email", email);
                set_text(o, "code", code);
                confirmation.write(o, "password");
            }
            AccountOp::RequestReauthCode => {}
            AccountOp::Reauth { proof } => match proof {
                ReauthProof::Password(password) => set_text(o, "password", password),
                ReauthProof::Code(code) => set_text(o, "code", code),
            },
            AccountOp::CreateFromPending { password, device, .. } => {
                if let Some(password) = password {
                    set_text(o, "password", password);
                }
                set_device(o, device);
            }
            AccountOp::ExchangeOAuthCode { code, code_verifier, device } => {
                set_text(o, "code", code);
                set_text(o, "code_verifier", code_verifier);
                set_device(o, device);
            }
            AccountOp::AppleNative { identity_token, authorization_code, nonce, name, device } => {
                set_text(o, "identityToken", identity_token);
                set_text(o, "authorizationCode", authorization_code);
                if let Some(nonce) = nonce {
                    set_text(o, "nonce", nonce);
                }
                if let Some(name) = name {
                    set_text(o, "name", name);
                }
                set_device(o, device);
            }
            AccountOp::LinkProvider { confirmation, native, .. } => {
                confirmation.write(o, "password");
                if let Some(native) = native {
                    set_text(o, "client", "native");
                    set_text(o, "redirect_uri", &native.redirect_uri);
                    set_text(o, "code_challenge", &native.code_challenge);
                    set_text(o, "state", &native.state);
                }
            }
            AccountOp::CompleteLink { code, code_verifier } => {
                set_text(o, "code", code);
                set_text(o, "code_verifier", code_verifier);
            }
            AccountOp::LinkAppleNative { identity_token, authorization_code, nonce, name, confirmation } => {
                set_text(o, "identityToken", identity_token);
                set_text(o, "authorizationCode", authorization_code);
                if let Some(nonce) = nonce {
                    set_text(o, "nonce", nonce);
                }
                if let Some(name) = name {
                    set_text(o, "name", name);
                }
                confirmation.write(o, "password");
            }
            AccountOp::Me
            | AccountOp::Logout { revoke: false }
            | AccountOp::RevokeAllSessions
            | AccountOp::CreateJoinToken
            | AccountOp::ListHosts
            | AccountOp::RequestPairing { .. }
            | AccountOp::ListDevices
            | AccountOp::AuthMethods
            | AccountOp::Identities
            | AccountOp::PendingSignIn { .. } => return None,
        }
        Some(Json::Object(Arc::new(object)).to_json())
    }
}

fn set_text(object: &mut JsonObject, key: &str, value: &str) {
    object.set(U16String::from_str(key), Json::from(value));
}

/// `deviceBody`: the claim as the body carries it, id first, name only when
/// there is one; nothing at all without a claim.
fn set_device(object: &mut JsonObject, device: &Option<AccountDeviceClaim>) {
    if let Some(device) = device {
        let mut claim = JsonObject::new();
        claim.set(U16String::from_str("id"), Json::from(device.id.as_str()));
        if let Some(name) = &device.name {
            claim.set(U16String::from_str("name"), Json::from(name.as_str()));
        }
        object.set(U16String::from_str("device"), Json::Object(Arc::new(claim)));
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

/// The signed-in user as `me`/`login` report it: `username` is what to show
/// (the email, or a legacy username), `email` the verified email when the
/// account has one (ADR-0044 §8).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountUser {
    pub username: String,
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub email: Option<String>,
}

/// A completed login: the session's expiry in epoch ms, plus the bearer
/// token when the server answered with one (cookie answers carry none).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct LoginSuccess {
    pub user: AccountUser,
    /// A legacy account the server wants an email for before going on
    /// (ADR-0044 §8) — only a literal `true` counts.
    #[cfg_attr(feature = "ffi", uniffi(default = false))]
    pub needs_email: bool,
    pub expires_at: f64,
    pub token: Option<String>,
}

/// `GET /api/me` — the user, and whether the server wants an email for it (ADR-0044 §8).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountMe {
    pub user: AccountUser,
    #[cfg_attr(feature = "ffi", uniffi(default = false))]
    pub needs_email: bool,
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

/// `POST /api/host-link/lookup` — the host waiting behind a typed code
/// (#495), as the confirm page shows it.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct HostLinkRequest {
    /// The host's id: the fingerprint of its registration key.
    pub host_id: String,
    pub name: String,
    pub os: String,
    /// The address the host asked from.
    pub source_ip: String,
    /// The host asked from another address than this device: maybe not the
    /// caller's machine.
    pub ip_differs: bool,
    pub expires_at: f64,
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

/// How a server lets people in (`GET /api/auth/methods`, ADR-0044).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AuthMethods {
    /// New accounts can be created here.
    pub registration: bool,
    /// The server can mail codes: email sign-up and password reset work.
    pub email: bool,
    /// Third-party sign-in providers the server has configured.
    pub providers: Vec<String>,
}

/// A sign-in provider bound to the account (`GET /api/me/identities`).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountIdentity {
    /// "google", "github" or "apple".
    pub provider: String,
    /// The email the provider gave, which may differ from the account's.
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub email: Option<String>,
    pub created_at: f64,
}

/// The account's ways in: its providers, and whether it has a password.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct AccountIdentities {
    pub identities: Vec<AccountIdentity>,
    pub has_password: bool,
}

/// A re-auth grant (ADR-0044 §6): good for the session that got it, until
/// `expires_at` (epoch ms).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ReauthGrant {
    pub reauth: String,
    pub expires_at: f64,
}

/// A provider sign-in that found no account yet (ADR-0044 §4).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PendingSignIn {
    pub provider: String,
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub email: Option<String>,
    #[cfg_attr(feature = "ffi", uniffi(default = None))]
    pub name: Option<String>,
}

/// Where finishing a pending sign-in leaves the caller: signed in, or — when
/// a native app's browser flow started it — the app's redirect with a
/// one-time code.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum PendingOutcome {
    SignedIn(LoginSuccess),
    Redirect(String),
}

/// iOS's own Sign in with Apple: signed in, or no account yet with the
/// pending id to create or link it (a 409 `no_account` on the wire).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum AppleNativeOutcome {
    SignedIn(LoginSuccess),
    NoAccount {
        pending: String,
        #[cfg_attr(feature = "ffi", uniffi(default = None))]
        email: Option<String>,
    },
}

/// The decoded success payload — which variant answers which op is fixed.
#[derive(Clone, Debug, PartialEq)]
pub enum AccountValue {
    /// `login`, `register` and `exchangeOAuthCode`.
    Login(LoginSuccess),
    /// `me` and `setEmail`.
    Me(AccountMe),
    /// `logout`, `revokeAllSessions`, the push-token pair, `changePassword`,
    /// `deleteAccount`, `kickDevice`, `removeHost`, `confirmHostLink`,
    /// `denyHostLink`, the email-code and reset ops, `unlinkProvider`,
    /// `requestReauthCode`, and a `linkPending` with no redirect answer
    /// nothing.
    Unit,
    JoinToken(JoinToken),
    HostLink(HostLinkRequest),
    /// Where a settled loopback host link sends the browser (#513): the
    /// host's own `http://127.0.0.1:<port>` listener. Also a `linkPending`
    /// a native app's browser flow started: its redirect. And the provider
    /// page a `linkProvider` opens (#631).
    Redirect(String),
    Hosts(Vec<AccountHost>),
    Devices(Vec<AccountDevice>),
    PairingOffer(PairingOffer),
    AuthMethods(AuthMethods),
    Identities(AccountIdentities),
    ReauthGrant(ReauthGrant),
    PendingSignIn(PendingSignIn),
    PendingOutcome(PendingOutcome),
    AppleNative(AppleNativeOutcome),
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

/// `{user: {username, email?}}` — everything else in the object is dropped,
/// like the reference's fresh `{user: {username, email?}}` result; an email
/// that isn't a string is left out.
fn user_body(value: &Json) -> Option<AccountUser> {
    // `isRecord(v)` lets arrays through in JS, but an array's `.user` reads
    // as undefined either way — `get` on a non-object misses identically.
    let user = value.get("user")?;
    let username = user.get("username").and_then(Json::as_str)?;
    Some(AccountUser {
        username: username.to_string_lossy(),
        email: str_field(user, "email"),
    })
}

/// `value.needsEmail === true`.
fn needs_email_flag(value: &Json) -> bool {
    matches!(value.get("needsEmail"), Some(Json::Bool(true)))
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

/// A loopback host link's redirect (#513), only when it goes to this
/// machine's 127.0.0.1 over plain http, as the server allows at start: the
/// client never sends a browser anywhere else on the server's word.
fn loopback_redirect(value: &Json) -> Option<String> {
    let redirect = str_field(value, "redirect")?;
    let url = Url::parse(&redirect).ok()?;
    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some()).then_some(redirect)
}

/// A native app's redirect after a provider sign-in, only to where the
/// server allows one at start (ADR-0044 §5): `pinomad://auth`, or this
/// machine's 127.0.0.1 over plain http.
fn native_redirect(value: &Json) -> Option<String> {
    let redirect = str_field(value, "redirect")?;
    let url = Url::parse(&redirect).ok()?;
    // `url.host === "auth"` in the reference: a port would show in it.
    let app = url.scheme() == "pinomad"
        && url.host_str() == Some("auth")
        && url.port().is_none()
        && (url.path().is_empty() || url.path() == "/");
    (app || loopback_redirect(value).is_some()).then_some(redirect)
}

/// `session()`: a login-shaped answer.
fn login_body(value: &Json) -> Result<LoginSuccess, AccountError> {
    Ok(LoginSuccess {
        user: user_body(value).ok_or_else(AccountError::invalid)?,
        needs_email: needs_email_flag(value),
        expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
        token: str_field(value, "token"),
    })
}

/// An optional string member: absent is `None`, present but not a string is malformed.
fn optional_str(value: &Json, key: &str) -> Result<Option<String>, AccountError> {
    match value.get(key) {
        None => Ok(None),
        Some(Json::String(text)) => Ok(Some(text.to_string_lossy())),
        Some(_) => Err(AccountError::invalid()),
    }
}

fn bool_field(value: &Json, key: &str) -> Result<bool, AccountError> {
    match value.get(key) {
        Some(Json::Bool(flag)) => Ok(*flag),
        _ => Err(AccountError::invalid()),
    }
}

/// The endpoint's own shape check on a parsed 2xx body (`None` = a body that
/// didn't parse or never arrived).
fn decode_value(kind: AccountOpKind, parsed: Option<&Json>) -> Result<AccountValue, AccountError> {
    let value = parsed.unwrap_or(&Json::Null);
    match kind {
        AccountOpKind::Login | AccountOpKind::Register | AccountOpKind::ExchangeOAuthCode => {
            Ok(AccountValue::Login(login_body(value)?))
        }
        AccountOpKind::Me | AccountOpKind::SetEmail => Ok(AccountValue::Me(AccountMe {
            user: user_body(value).ok_or_else(AccountError::invalid)?,
            needs_email: needs_email_flag(value),
        })),
        // `result.ok ? ok(undefined)` — any 2xx answers the void ops.
        AccountOpKind::Logout
        | AccountOpKind::RevokeAllSessions
        | AccountOpKind::RegisterPushToken
        | AccountOpKind::RemovePushToken
        | AccountOpKind::ChangePassword
        | AccountOpKind::DeleteAccount
        | AccountOpKind::KickDevice
        | AccountOpKind::RemoveHost
        | AccountOpKind::ConfirmHostLink
        | AccountOpKind::DenyHostLink
        | AccountOpKind::RequestSignupCode
        | AccountOpKind::RequestPasswordReset
        | AccountOpKind::ResetPassword
        | AccountOpKind::RequestEmailCode
        | AccountOpKind::UnlinkProvider
        | AccountOpKind::LinkAppleNative
        | AccountOpKind::CompleteLink
        | AccountOpKind::RequestReauthCode => Ok(AccountValue::Unit),
        AccountOpKind::AuthMethods => {
            let providers = value.get("providers").and_then(Json::as_array).ok_or_else(AccountError::invalid)?;
            Ok(AccountValue::AuthMethods(AuthMethods {
                registration: bool_field(value, "registration")?,
                email: bool_field(value, "email")?,
                providers: providers
                    .iter()
                    .map(|provider| provider.as_str().map(|s| s.to_string_lossy()).ok_or_else(AccountError::invalid))
                    .collect::<Result<_, _>>()?,
            }))
        }
        AccountOpKind::Identities => {
            let has_password = bool_field(value, "hasPassword")?;
            let entries = value.get("identities").and_then(Json::as_array).ok_or_else(AccountError::invalid)?;
            let mut identities = Vec::with_capacity(entries.len());
            for entry in entries.iter() {
                identities.push(AccountIdentity {
                    provider: str_field(entry, "provider").ok_or_else(AccountError::invalid)?,
                    email: optional_str(entry, "email")?,
                    created_at: num_field(entry, "createdAt").ok_or_else(AccountError::invalid)?,
                });
            }
            Ok(AccountValue::Identities(AccountIdentities { identities, has_password }))
        }
        AccountOpKind::Reauth => Ok(AccountValue::ReauthGrant(ReauthGrant {
            reauth: str_field(value, "reauth").ok_or_else(AccountError::invalid)?,
            expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
        })),
        AccountOpKind::PendingSignIn => Ok(AccountValue::PendingSignIn(PendingSignIn {
            provider: str_field(value, "provider").ok_or_else(AccountError::invalid)?,
            email: optional_str(value, "email")?,
            name: optional_str(value, "name")?,
        })),
        // `isRecord(value) && "redirect" in value` picks the redirect shape;
        // anything else must be a session.
        AccountOpKind::CreateFromPending => Ok(AccountValue::PendingOutcome(if value.get("redirect").is_some() {
            PendingOutcome::Redirect(native_redirect(value).ok_or_else(AccountError::invalid)?)
        } else {
            PendingOutcome::SignedIn(login_body(value)?)
        })),
        // No body (a 204, or one that didn't parse) is the plain link.
        AccountOpKind::LinkPending => match parsed {
            None => Ok(AccountValue::Unit),
            Some(value) => native_redirect(value).map(AccountValue::Redirect).ok_or_else(AccountError::invalid),
        },
        AccountOpKind::AppleNative => Ok(AccountValue::AppleNative(AppleNativeOutcome::SignedIn(login_body(value)?))),
        // Only a web page: the browser is sent there on the server's word.
        AccountOpKind::LinkProvider => str_field(value, "url")
            .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
            .map(AccountValue::Redirect)
            .ok_or_else(AccountError::invalid),
        AccountOpKind::ConfirmHostLinkRequest | AccountOpKind::DenyHostLinkRequest => {
            loopback_redirect(value).map(AccountValue::Redirect).ok_or_else(AccountError::invalid)
        }
        AccountOpKind::LookupHostLink | AccountOpKind::LookupHostLinkRequest => Ok(AccountValue::HostLink(HostLinkRequest {
            host_id: str_field(value, "hostId").ok_or_else(AccountError::invalid)?,
            name: str_field(value, "name").ok_or_else(AccountError::invalid)?,
            os: str_field(value, "os").ok_or_else(AccountError::invalid)?,
            source_ip: str_field(value, "sourceIp").ok_or_else(AccountError::invalid)?,
            ip_differs: match value.get("ipDiffers") {
                Some(Json::Bool(differs)) => *differs,
                _ => return Err(AccountError::invalid()),
            },
            expires_at: num_field(value, "expiresAt").ok_or_else(AccountError::invalid)?,
        })),
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
    // iOS's own Apple sign-in with no account yet: the refusal carries the
    // pending id the app finishes it with.
    if kind == AccountOpKind::AppleNative && code == "no_account" {
        if let Some(pending) = json.as_ref().and_then(|value| str_field(value, "pending")) {
            let email = json.as_ref().and_then(|value| str_field(value, "email"));
            return Ok(AccountValue::AppleNative(AppleNativeOutcome::NoAccount { pending, email }));
        }
    }
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
