// Pairing links (packages/protocol/src/pairing-link.ts): a link carries the
// host's Noise public key plus a one-time secret in `pair=<key>.<secret>`;
// the socket URL comes from `url=` or defaults to the link host for
// http(s) links. The parser is deliberately strict — a malformed link is a
// rejected pairing attempt, never a best-effort connect.

use crate::b64::from_base64url;
use crate::noise::KEY_LENGTH;

/// `pair=` payload, decoded.
#[derive(Clone, Debug, PartialEq)]
pub struct PairParam {
    pub host_key: [u8; KEY_LENGTH],
    pub secret: String,
}

/// A validated link: where to connect and what to pair with.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedPairing {
    pub host_key: [u8; KEY_LENGTH],
    pub secret: String,
    pub url: String,
}

/// `parsePairParam` — exactly one dot, a 32-byte base64url host key, and a
/// base64url secret that decodes to at least one byte.
pub fn parse_pair_param(param: &str) -> Option<PairParam> {
    let (host_key, secret) = param.split_once('.')?;
    if secret.contains('.') || host_key.is_empty() {
        return None;
    }
    let key_bytes = from_base64url(host_key).ok()?;
    if key_bytes.len() != KEY_LENGTH {
        return None;
    }
    if from_base64url(secret).ok()?.is_empty() {
        return None;
    }
    Some(PairParam {
        host_key: key_bytes.try_into().expect("checked above"),
        secret: secret.to_string(),
    })
}

/// JavaScript's encodeURIComponent: unreserved + `! ' * ( )` pass through,
/// everything else is %-escaped UTF-8.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The fragment fields of a pasted link, in URLSearchParams order.
fn fragment_fields(pasted: &str) -> Option<(url::Url, String, Option<String>)> {
    let link = url::Url::parse(pasted.trim()).ok()?;
    let mut pair: Option<String> = None;
    let mut link_url: Option<String> = None;
    for (name, value) in url::form_urlencoded::parse(link.fragment()?.as_bytes()) {
        match name.as_ref() {
            // URLSearchParams.get returns the FIRST occurrence — later
            // duplicates are shadowed, not merged.
            "pair" if pair.is_none() => pair = Some(value.into_owned()),
            "url" if link_url.is_none() => link_url = Some(value.into_owned()),
            _ => {}
        }
    }
    Some((link, pair?, link_url))
}

/// `pairingFragment` — turn a pasted link into `pair=<pair>&url=<url>`
/// (the fragment resolveAddress reads, WITHOUT the leading `#`), or None
/// when the link is not a usable pairing link. Every other fragment field —
/// a smuggled `token=`, say — is dropped on the floor.
pub fn pairing_fragment(pasted: &str) -> Option<String> {
    let (link, pair, link_url) = fragment_fields(pasted)?;
    if pair.is_empty() || parse_pair_param(&pair).is_none() {
        return None;
    }
    // Empty url behaves like a missing one; a present url must parse as a
    // ws:/wss: URL — not merely start with a ws-looking prefix.
    let socket = match link_url.as_deref().filter(|u| !u.is_empty()) {
        Some(raw) => {
            let parsed = url::Url::parse(raw).ok()?;
            if !matches!(parsed.scheme(), "ws" | "wss") {
                return None;
            }
            raw.to_string()
        }
        None => match link.scheme() {
            "http" | "https" => {
                let host = link.host_str().unwrap_or_default();
                let port = link.port().map(|p| format!(":{p}")).unwrap_or_default();
                let scheme = if link.scheme() == "https" { "wss" } else { "ws" };
                format!("{scheme}://{host}{port}/")
            }
            _ => return None,
        },
    };
    Some(format!("pair={}&url={}", pair, encode_uri_component(&socket)))
}

/// Parse a pasted pairing link all the way to what `SecureTransport` needs —
/// the same rules as `pairing_fragment`.
pub fn parse_pairing_link(pasted: &str) -> Option<ParsedPairing> {
    let (link, pair, link_url) = fragment_fields(pasted)?;
    let pair = parse_pair_param(&pair)?;
    let socket = match link_url.as_deref().filter(|u| !u.is_empty()) {
        Some(raw) => {
            let parsed = url::Url::parse(raw).ok()?;
            if !matches!(parsed.scheme(), "ws" | "wss") {
                return None;
            }
            raw.to_string()
        }
        None => match link.scheme() {
            "http" | "https" => {
                let host = link.host_str().unwrap_or_default();
                let port = link.port().map(|p| format!(":{p}")).unwrap_or_default();
                let scheme = if link.scheme() == "https" { "wss" } else { "ws" };
                format!("{scheme}://{host}{port}/")
            }
            _ => return None,
        },
    };
    Some(ParsedPairing { host_key: pair.host_key, secret: pair.secret, url: socket })
}
