// The server-accounts client at the boundary (ADR-0022): the core owns
// request construction and answer parsing, the platform's HTTP stack owns
// the transport. A request that never gets an answer never reaches here —
// the platform reports `code: "network"` itself, like the reference's fetch
// seam does. The probe's 5-second timeout (headers AND body read) is also
// the platform's; the core only judges the outcome.

use crate::account as core;
use crate::ffi::hosts::{EndpointSet, StoredHost, StoredHostAccount};

pub use crate::account::{
    AccountError, AccountHost, AccountHostPairing, AccountHostStatus, AccountHttpHeader,
    AccountHttpRequest, AccountOp, AccountOpKind, AccountUser, AccountsProbe, JoinToken,
    LoginSuccess,
};

/// The pairing answer at the boundary: the core's typed value plus the
/// optional remote candidate set (ADR-0032). The core record itself keeps
/// the UTF-16-safe endpoint model, so the FFI twin is the typed copy.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PairingOffer {
    pub url: String,
    pub host_key: String,
    pub secret: String,
    pub expires_at: f64,
    #[uniffi(default = None)]
    pub endpoint_set: Option<EndpointSet>,
}

impl PairingOffer {
    fn from_core(offer: &core::PairingOffer) -> Self {
        PairingOffer {
            url: offer.url.clone(),
            host_key: offer.host_key.clone(),
            secret: offer.secret.clone(),
            expires_at: offer.expires_at,
            endpoint_set: offer.endpoint_set.as_ref().map(EndpointSet::from_core),
        }
    }

    fn to_core(&self) -> core::PairingOffer {
        core::PairingOffer {
            url: self.url.clone(),
            host_key: self.host_key.clone(),
            secret: self.secret.clone(),
            expires_at: self.expires_at,
            endpoint_set: self.endpoint_set.as_ref().and_then(EndpointSet::to_core),
        }
    }
}

/// The decoded success payload, mirroring `core::AccountValue`.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum AccountValue {
    Login(LoginSuccess),
    Me(AccountUser),
    Unit,
    JoinToken(JoinToken),
    Hosts(Vec<AccountHost>),
    PairingOffer(PairingOffer),
}

fn value_from_core(value: core::AccountValue) -> AccountValue {
    match value {
        core::AccountValue::Login(value) => AccountValue::Login(value),
        core::AccountValue::Me(value) => AccountValue::Me(value),
        core::AccountValue::Unit => AccountValue::Unit,
        core::AccountValue::JoinToken(value) => AccountValue::JoinToken(value),
        core::AccountValue::Hosts(value) => AccountValue::Hosts(value),
        core::AccountValue::PairingOffer(value) => {
            AccountValue::PairingOffer(PairingOffer::from_core(&value))
        }
    }
}

/// One `matchAccountHosts` verdict — `stored` is the FFI record, not the
/// core's raw-carrying one.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AccountHostMatch {
    pub host: AccountHost,
    pub status: AccountHostStatus,
    /// The stored pairing behind a `paired`/`key_changed` verdict.
    pub stored: Option<StoredHost>,
    /// The stored entry shares the Noise key but predates account linkage —
    /// persisting `{...stored, account}` adopts the association.
    pub linkable: bool,
}

fn to_core(host: &StoredHost) -> crate::stored_host::StoredHost {
    crate::stored_host::StoredHost {
        url: host.url.clone(),
        host_key: host.host_key.clone(),
        private_key: host.private_key.clone(),
        name: host.name.clone(),
        account: host.account.as_ref().map(|link| {
            crate::stored_host::StoredHostAccount::new(
                link.server_origin.clone(),
                link.host_id.clone(),
            )
        }),
        endpoint_set: host.endpoint_set.as_ref().and_then(EndpointSet::to_core),
    }
}

fn from_core(host: &crate::stored_host::StoredHost) -> StoredHost {
    StoredHost {
        url: host.url.clone(),
        host_key: host.host_key.clone(),
        private_key: host.private_key.clone(),
        name: host.name.clone(),
        account: host.account.as_ref().map(|link| StoredHostAccount {
            server_origin: link.server_origin.clone(),
            host_id: link.host_id.clone(),
        }),
        endpoint_set: host.endpoint_set.as_ref().map(EndpointSet::from_core),
    }
}

/// Build the request for one account call — `method` on `url` with
/// `headers` in order, then `body` when present. The origin is normalized
/// (`new URL().origin` semantics); `token` rides as `Authorization: Bearer`.
#[uniffi::export]
pub fn account_request(origin: String, token: Option<String>, op: AccountOp) -> AccountHttpRequest {
    core::account_request(&origin, token.as_deref(), &op)
}

/// The account probe's request: `GET {origin}/api/me`. The verdict comes
/// from `probe_verdict` once the transport answers (or doesn't, inside the
/// platform's 5-second timeout).
#[uniffi::export]
pub fn account_probe_request(origin: String) -> AccountHttpRequest {
    core::account_probe_request(&origin)
}

/// Parse the answer to a request `account_request` built — `op_kind` is the
/// sent op's `kind`, `status` the HTTP status, `body` the decoded body text
/// ("" when absent, like a 204). Errors carry the server's `error` code
/// verbatim plus the status; `invalid_response` has none.
#[uniffi::export]
pub fn account_response(
    op_kind: AccountOpKind,
    status: u16,
    body: String,
) -> Result<AccountValue, AccountError> {
    core::account_response(op_kind, status, &body).map(value_from_core)
}

/// The probe verdict: `status` None means the request failed or timed out,
/// `body` None on a 200 means the body never finished inside the timeout.
#[uniffi::export]
pub fn probe_verdict(status: Option<u16>, body: Option<String>) -> AccountsProbe {
    core::probe_verdict(status, body.as_deref())
}

/// Whether the account API may ride this origin — https everywhere, http
/// only on loopback.
#[uniffi::export]
pub fn is_secure_server_origin(origin: String) -> bool {
    core::is_secure_server_origin(&origin)
}

/// `new URL().origin` canonical form — or the input minus trailing slashes
/// when it won't parse.
#[uniffi::export]
pub fn normalize_server_origin(origin: String) -> String {
    core::normalize_server_origin(&origin)
}

/// Pair the server's account hosts against the stored pairings: `paired`
/// (account-linked or same Noise key), `unpaired`, or `key_changed` — a
/// link whose pinned key diverged is reported, never silently re-paired.
#[uniffi::export]
pub fn match_account_hosts(
    server_origin: String,
    hosts: Vec<AccountHost>,
    stored: Vec<StoredHost>,
) -> Vec<AccountHostMatch> {
    let stored_core: Vec<crate::stored_host::StoredHost> = stored.iter().map(to_core).collect();
    core::match_account_hosts(&server_origin, &hosts, &stored_core)
        .iter()
        .map(|m| AccountHostMatch {
            host: m.host.clone(),
            status: m.status,
            stored: m.stored.as_ref().map(from_core),
            linkable: m.linkable,
        })
        .collect()
}

/// The pairing offer as a `pinomad://pair#pair=…&url=…` deep link —
/// acceptable to `pairing_target`/`PinomadClient.pair`. `None` when the
/// offer fails the pairing-link rule; the platform reports `invalid_offer`.
#[uniffi::export]
pub fn account_pairing_link(offer: PairingOffer) -> Option<String> {
    core::account_pairing_link(&offer.to_core())
}
