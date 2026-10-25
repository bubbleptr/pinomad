// Pairing links (packages/protocol/src/pairing-link.ts): a link carries the
// host's Noise public key plus a one-time secret in `pair=<key>.<secret>`;
// the socket URL comes from `url=` or defaults to the link host for
// http(s) links. The parser is deliberately strict — a malformed link is a
// rejected pairing attempt, never a best-effort connect.

use url::Url;

use crate::b64::from_base64url;
use crate::endpoints::{parse_endpoint_set_text, EndpointSet, ParsedEndpointSet};
use crate::noise::KEY_LENGTH;

/// `pair=` payload, decoded.
#[derive(Clone, Debug, PartialEq)]
pub struct PairParam {
    pub host_key: [u8; KEY_LENGTH],
    pub secret: String,
}

/// A validated link: where to connect, what to pair with, and the remote
/// candidates when the invite carries a usable set.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedPairing {
    pub host_key: [u8; KEY_LENGTH],
    pub secret: String,
    pub url: String,
    pub endpoint_set: Option<EndpointSet>,
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

struct FragmentFields {
    link: Url,
    pair: String,
    url: Option<String>,
    endpoint_set: Option<String>,
    duplicate_endpoint_set: bool,
}

/// The fragment fields of a pasted link, in URLSearchParams order. `pair`
/// and `url` keep the reference's first-wins rule; a duplicate
/// `endpointSet` is recorded because the invite must be rejected.
fn fragment_fields(pasted: &str) -> Option<FragmentFields> {
    let link = Url::parse(pasted.trim()).ok()?;
    let mut pair: Option<String> = None;
    let mut link_url: Option<String> = None;
    let mut endpoint_set: Option<String> = None;
    let mut endpoint_seen = false;
    let mut duplicate_endpoint_set = false;
    for (name, value) in url::form_urlencoded::parse(link.fragment()?.as_bytes()) {
        match name.as_ref() {
            "pair" if pair.is_none() => pair = Some(value.into_owned()),
            "url" if link_url.is_none() => link_url = Some(value.into_owned()),
            "endpointSet" => {
                if endpoint_seen {
                    duplicate_endpoint_set = true;
                } else {
                    endpoint_seen = true;
                    endpoint_set = Some(value.into_owned());
                }
            }
            _ => {}
        }
    }
    Some(FragmentFields {
        link,
        pair: pair?,
        url: link_url,
        endpoint_set,
        duplicate_endpoint_set,
    })
}

fn socket_url(link: &Url, link_url: Option<&str>) -> Option<String> {
    match link_url.filter(|u| !u.is_empty()) {
        Some(raw) => {
            let parsed = Url::parse(raw).ok()?;
            if !matches!(parsed.scheme(), "ws" | "wss") {
                return None;
            }
            Some(raw.to_string())
        }
        None => match link.scheme() {
            "http" | "https" => {
                let host = link.host_str().unwrap_or_default();
                let port = link.port().map(|p| format!(":{p}")).unwrap_or_default();
                let scheme = if link.scheme() == "https" { "wss" } else { "ws" };
                Some(format!("{scheme}://{host}{port}/"))
            }
            _ => None,
        },
    }
}

/// A set the link carries: absent/unsupported falls back to the legacy url;
/// a malformed or explicitly empty set rejects the whole invite.
fn link_endpoint_set(raw: Option<&str>) -> Result<Option<EndpointSet>, ()> {
    match raw {
        None => Ok(None),
        Some(raw) => match parse_endpoint_set_text(raw) {
            ParsedEndpointSet::Valid(set) if !set.endpoints.is_empty() => Ok(Some(set)),
            ParsedEndpointSet::Valid(_) | ParsedEndpointSet::Malformed => Err(()),
            ParsedEndpointSet::Unsupported | ParsedEndpointSet::Absent => Ok(None),
        },
    }
}

fn parse_fragment(pasted: &str) -> Option<(String, PairParam, String, Option<EndpointSet>)> {
    let fields = fragment_fields(pasted)?;
    if fields.duplicate_endpoint_set || fields.pair.is_empty() {
        return None;
    }
    let pair = parse_pair_param(&fields.pair)?;
    let socket = socket_url(&fields.link, fields.url.as_deref())?;
    let endpoint_set = link_endpoint_set(fields.endpoint_set.as_deref()).ok()?;
    Some((fields.pair, pair, socket, endpoint_set))
}

/// `pairingFragment` — turn a pasted link into the fragment resolveAddress
/// reads (WITHOUT the leading `#`), or None when the link is not a usable
/// pairing link. Every other fragment field — a smuggled `token=`, say — is
/// dropped on the floor. A usable endpoint set is re-emitted canonically.
pub fn pairing_fragment(pasted: &str) -> Option<String> {
    let (pair, _, socket, endpoint_set) = parse_fragment(pasted)?;
    let mut out = format!("pair={}&url={}", pair, encode_uri_component(&socket));
    if let Some(set) = endpoint_set {
        out.push_str("&endpointSet=");
        out.push_str(&encode_uri_component(&set.to_json().to_json()));
    }
    Some(out)
}

/// Parse a pasted pairing link all the way to what `SecureTransport` needs —
/// the same rules as `pairing_fragment`.
pub fn parse_pairing_link(pasted: &str) -> Option<ParsedPairing> {
    let (_, pair, socket, endpoint_set) = parse_fragment(pasted)?;
    Some(ParsedPairing {
        host_key: pair.host_key,
        secret: pair.secret,
        url: socket,
        endpoint_set,
    })
}
