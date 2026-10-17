// Stored host entry validation from packages/client/src/stored-host.ts: only
// ws/wss urls, and keys that are base64url of exactly 32 bytes.
use std::collections::HashMap;

use url::Url;

use crate::b64::from_base64url;
use crate::json::Json;

fn lossy(value: Option<&Json>) -> String {
    value
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .unwrap_or_default()
}

/// `typeof value === "string" && fromBase64Url(value).length === 32`.
fn is_key(value: Option<&Json>) -> bool {
    let Some(text) = value.and_then(Json::as_str) else {
        return false;
    };
    from_base64url(&text.to_string_lossy())
        .map(|bytes| bytes.len() == 32)
        .unwrap_or(false)
}

/// `typeof value === "string" && new URL(value).protocol in {ws:, wss:}`.
fn is_host_url(value: Option<&Json>) -> bool {
    let Some(text) = value.and_then(Json::as_str) else {
        return false;
    };
    match Url::parse(&text.to_string_lossy()) {
        Ok(url) => url.scheme() == "ws" || url.scheme() == "wss",
        Err(_) => false,
    }
}

/// The account linkage of a paired host (ADR-0022): which server bound the
/// host and under what hostId.
#[derive(Clone, Debug)]
pub struct StoredHostAccount {
    pub server_origin: String,
    /// base64url of the host's 32-byte relay key, like hostKey.
    pub host_id: String,
    /// The stored object verbatim — the reference emits it with any extra
    /// fields intact.
    raw: Json,
}

impl StoredHostAccount {
    /// The account object as stored — the reference emits it verbatim.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }

    fn is_link(value: &Json) -> bool {
        // `typeof value === "object" && value !== null` — arrays pass the type
        // check but carry no serverOrigin.
        (value.is_container())
            && value
                .get("serverOrigin")
                .and_then(Json::as_str)
                .is_some_and(|s| !s.units().is_empty())
            && is_key(value.get("hostId"))
    }
}

/// One paired host: where to dial and this device's identity on it.
#[derive(Clone, Debug)]
pub struct StoredHost {
    pub url: String,
    pub host_key: String,
    pub private_key: String,
    /// Present only when the stored link validated — a malformed one costs
    /// the association, not the pairing.
    pub account: Option<StoredHostAccount>,
}

/// `parseStoredHost`: a validated stored host, or None.
pub fn parse_stored_host(value: &Json) -> Option<StoredHost> {
    // `typeof value !== "object" || value === null` — arrays/objects only.
    if !(value.is_container()) {
        return None;
    }
    if !is_host_url(value.get("url")) || !is_key(value.get("hostKey")) || !is_key(value.get("privateKey")) {
        return None;
    }
    let account = value.get("account").filter(|a| StoredHostAccount::is_link(a)).map(|a| {
        StoredHostAccount {
            server_origin: lossy(a.get("serverOrigin")),
            host_id: lossy(a.get("hostId")),
            raw: a.clone(),
        }
    });
    Some(StoredHost {
        url: lossy(value.get("url")),
        host_key: lossy(value.get("hostKey")),
        private_key: lossy(value.get("privateKey")),
        account,
    })
}

/// `new URL(url).host` — the host part plus a non-default port.
fn url_host(url_text: &str) -> String {
    match Url::parse(url_text) {
        Ok(url) => match url.port() {
            Some(port) => format!("{}:{}", url.host_str().unwrap_or(""), port),
            None => url.host_str().unwrap_or("").to_string(),
        },
        // `new URL` throws → the raw url is the label.
        Err(_) => url_text.to_string(),
    }
}

/// A host picker's row label — one `hostLabels` map entry.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct HostLabel {
    pub host_key: String,
    pub label: String,
}

/// `hostLabels`: sidebar/menu label per host — the URL's host, disambiguated
/// by the hostKey prefix when two hosts share one (e.g. two hosts behind the
/// same relay). Host-key order is input order, like the Map.
pub fn host_labels(hosts: &[StoredHost]) -> Vec<HostLabel> {
    let bases: Vec<String> = hosts.iter().map(|host| url_host(&host.url)).collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for base in &bases {
        *counts.entry(base.as_str()).or_default() += 1;
    }
    hosts
        .iter()
        .zip(&bases)
        .map(|(host, base)| {
            let label = if counts[base.as_str()] > 1 {
                // `hostKey.slice(0, 6)` — UTF-16 units like the reference.
                let prefix: Vec<u16> = host.host_key.encode_utf16().take(6).collect();
                format!("{base} · {}", String::from_utf16_lossy(&prefix))
            } else {
                base.clone()
            };
            HostLabel {
                host_key: host.host_key.clone(),
                label,
            }
        })
        .collect()
}
