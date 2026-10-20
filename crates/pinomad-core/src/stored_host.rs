// Stored host entry validation from packages/client/src/stored-host.ts: only
// ws/wss urls, and keys that are base64url of exactly 32 bytes.
use std::collections::HashMap;
use std::sync::Arc;

use url::Url;

use crate::b64::from_base64url;
use crate::json::{Json, JsonObject};
use crate::u16str::U16String;

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
    /// A link from the two fields alone — FFI records and generated inputs
    /// carry no extra fields, so `raw` recomposes as `{serverOrigin, hostId}`.
    pub fn new(server_origin: String, host_id: String) -> Self {
        let mut raw = JsonObject::new();
        raw.set(
            U16String::from_str("serverOrigin"),
            Json::from(server_origin.clone()),
        );
        raw.set(U16String::from_str("hostId"), Json::from(host_id.clone()));
        StoredHostAccount {
            server_origin,
            host_id,
            raw: Json::Object(Arc::new(raw)),
        }
    }

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
    /// The machine's display name, cached from the host's settings (5.12).
    /// A wrong shape or an empty one is no name — the URL host labels it then.
    pub name: Option<String>,
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
    // `typeof host.name === "string" && host.name !== ""` — a malformed name
    // costs the field, not the pairing.
    let name = value
        .get("name")
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .filter(|n| !n.is_empty());
    Some(StoredHost {
        url: lossy(value.get("url")),
        host_key: lossy(value.get("hostKey")),
        private_key: lossy(value.get("privateKey")),
        name,
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

/// `hostLabels`: sidebar/menu label per host (5.12) — the stored machine
/// name when the host announced one, else the URL's host. Labels must end up
/// unique: a base shared by several hosts gains its hostKey prefix — six
/// UTF-16 units first, lengthened while a collision remains (a stored name
/// can shadow another host's disambiguated label). Host-key order is input
/// order, like the Map.
pub fn host_labels(hosts: &[StoredHost]) -> Vec<HostLabel> {
    let bases: Vec<String> = hosts
        .iter()
        .map(|host| host.name.clone().unwrap_or_else(|| url_host(&host.url)))
        .collect();
    // The hostKey prefix length per entry — 0 keeps the plain base.
    let mut suffix = vec![0usize; hosts.len()];
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for base in &bases {
        *counts.entry(base.as_str()).or_default() += 1;
    }
    for (i, base) in bases.iter().enumerate() {
        if counts[base.as_str()] > 1 {
            suffix[i] = 6;
        }
    }
    let label = |suffix: &[usize], i: usize| -> String {
        if suffix[i] == 0 {
            bases[i].clone()
        } else {
            // `hostKey.slice(0, suffix)` — UTF-16 units like the reference.
            let prefix: Vec<u16> = hosts[i].host_key.encode_utf16().take(suffix[i]).collect();
            format!("{} · {}", bases[i], String::from_utf16_lossy(&prefix))
        }
    };
    // Lengthen colliding suffixes until no two labels match. Only a suffixed
    // label can grow — a plain base is the host's literal label. Distinct
    // hostKeys diverge inside 43 units, so this converges; the `grew` guard
    // bounds the pathological case (two entries sharing base and key).
    loop {
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut collided: Vec<usize> = Vec::new();
        for i in 0..hosts.len() {
            let text = label(&suffix, i);
            match seen.get(&text) {
                None => {
                    seen.insert(text, i);
                }
                Some(&other) => {
                    collided.push(other);
                    collided.push(i);
                }
            }
        }
        if collided.is_empty() {
            break;
        }
        // A three-way collision pushes an index twice — dedup so each host
        // grows once per round, matching the reference's Set.
        collided.sort_unstable();
        collided.dedup();
        let mut grew = false;
        for i in collided {
            if suffix[i] > 0 && suffix[i] < hosts[i].host_key.encode_utf16().count() {
                suffix[i] += 1;
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    (0..hosts.len())
        .map(|i| HostLabel {
            host_key: hosts[i].host_key.clone(),
            label: label(&suffix, i),
        })
        .collect()
}
