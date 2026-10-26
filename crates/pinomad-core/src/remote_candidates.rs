// Candidate planning for one connection round (packages/protocol/src/
// remote-candidates.ts, ADR-0032): turn a host's published endpoints into
// the ordered sockets this client dials. Pure and platform-neutral.
//
// Auto order is client-local loopback, then the host's relays in published
// order, then its directs in published order. Only one socket is live at a
// time; ranking and online switching are deliberately absent.

use std::collections::HashSet;

use url::{Host, Url};

use crate::connection_mode::ConnectionMode;
use crate::endpoints::{EndpointSet, HostEndpoint, HostEndpointRole};

/// Why a candidate cannot be dialled at all; reported as a skipped path,
/// never as a host outage.
pub const MIXED_CONTENT_REASON: &str =
    "mixed content: this HTTPS page blocks the insecure ws:// connection";

pub const DIRECT_UNAVAILABLE: &str =
    "Direct connection unavailable: this host cannot be reached without the relay and WebRTC did not connect.";

/// Business paths allowed by a mode (ADR-0033 §3). A legacy URL has no role
/// evidence: Relay-only keeps it, Direct-only drops it.
pub fn filter_candidates_for_mode(
    candidates: &[RemoteCandidate],
    mode: ConnectionMode,
) -> Vec<RemoteCandidate> {
    candidates
        .iter()
        .filter(|candidate| match mode {
            ConnectionMode::Auto => true,
            ConnectionMode::RelayOnly => matches!(
                candidate.role,
                RemoteCandidateRole::Loopback | RemoteCandidateRole::Relay | RemoteCandidateRole::Legacy
            ),
            ConnectionMode::DirectOnly => matches!(
                candidate.role,
                RemoteCandidateRole::Loopback | RemoteCandidateRole::Direct
            ),
        })
        .cloned()
        .collect()
}

/// The relay sockets a Direct-only client may use for a signal-only connection.
pub fn signal_candidates(candidates: &[RemoteCandidate]) -> Vec<RemoteCandidate> {
    candidates
        .iter()
        .filter(|candidate| matches!(candidate.role, RemoteCandidateRole::Relay | RemoteCandidateRole::Legacy))
        .cloned()
        .collect()
}

/// The path role a candidate plays for this client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteCandidateRole {
    Loopback,
    Relay,
    Direct,
    Legacy,
}

impl RemoteCandidateRole {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteCandidateRole::Loopback => "loopback",
            RemoteCandidateRole::Relay => "relay",
            RemoteCandidateRole::Direct => "direct",
            RemoteCandidateRole::Legacy => "legacy",
        }
    }
}

/// One ordered dial target. `unsupported` is a platform verdict (for example
/// mixed content) that skips the path while still reporting why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteCandidate {
    pub url: String,
    pub role: RemoteCandidateRole,
    pub unsupported: Option<String>,
}

/// Whether a host name only reaches the machine itself. Hosts filter these
/// from published sets; pairing presentation uses the same boundary.
pub fn is_loopback_hostname(hostname: &str) -> bool {
    let host = hostname
        .to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_string();
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

/// The same predicate for a URL; unparseable input is not loopback.
pub fn is_loopback_url(url: &str) -> bool {
    match Url::parse(url) {
        Ok(parsed) => match parsed.host() {
            Some(Host::Domain(domain)) => is_loopback_hostname(domain),
            Some(Host::Ipv4(address)) => address.is_loopback(),
            Some(Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        },
        Err(_) => false,
    }
}

fn is_insecure_remote(url: &str) -> bool {
    match Url::parse(url) {
        Ok(parsed) => parsed.scheme() == "ws" && !is_loopback_url(url),
        Err(_) => false,
    }
}

fn unsupported_for(url: &str, page_protocol: Option<&str>) -> Option<String> {
    (page_protocol == Some("https:") && is_insecure_remote(url))
        .then(|| MIXED_CONTENT_REASON.to_string())
}

/// The Auto order for one round.
///
/// A usable endpoint set owns the remote candidates: a non-loopback legacy
/// `url` is not added when the set is present (including an explicit empty
/// set). Without a set the legacy `url` is the only remote candidate, kept
/// for old hosts and records. Identical URLs are dialled once, first role
/// wins.
pub fn candidate_plan(
    legacy_url: &str,
    endpoint_set: Option<&EndpointSet>,
    page_protocol: Option<&str>,
) -> Vec<RemoteCandidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |url: &str, role: RemoteCandidateRole| {
        if !seen.insert(url.to_string()) {
            return;
        }
        candidates.push(RemoteCandidate {
            url: url.to_string(),
            role,
            unsupported: unsupported_for(url, page_protocol),
        });
    };

    if is_loopback_url(legacy_url) {
        add(legacy_url, RemoteCandidateRole::Loopback);
    }
    if let Some(set) = endpoint_set {
        for endpoint in &set.endpoints {
            if endpoint.role == HostEndpointRole::Relay {
                add(&endpoint.url.to_string_lossy(), RemoteCandidateRole::Relay);
            }
        }
        for endpoint in &set.endpoints {
            if endpoint.role == HostEndpointRole::Direct {
                add(&endpoint.url.to_string_lossy(), RemoteCandidateRole::Direct);
            }
        }
    } else if !is_loopback_url(legacy_url) {
        add(legacy_url, RemoteCandidateRole::Legacy);
    }
    candidates
}

fn preferred(endpoints: &[HostEndpoint], role: HostEndpointRole) -> Option<String> {
    endpoints
        .iter()
        .find(|endpoint| endpoint.role == role)
        .map(|endpoint| endpoint.url.to_string_lossy())
}

/// The legacy `url` a stored host should carry while old clients still read
/// it: relay first, else the first direct. A loopback entry is client-local
/// and never changes; an empty remote set has no valid legacy expression, so
/// the old value stays and new clients trust the empty set.
pub fn preferred_legacy_url(current_url: &str, endpoint_set: &EndpointSet) -> String {
    if is_loopback_url(current_url) {
        return current_url.to_string();
    }
    preferred(&endpoint_set.endpoints, HostEndpointRole::Relay)
        .or_else(|| preferred(&endpoint_set.endpoints, HostEndpointRole::Direct))
        .unwrap_or_else(|| current_url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoints::HostEndpoint;

    fn set(entries: &[(HostEndpointRole, &str)]) -> EndpointSet {
        EndpointSet {
            schema_version: 1,
            endpoints: entries
                .iter()
                .map(|(role, url)| HostEndpoint {
                    role: *role,
                    url: crate::u16str::U16String::from_str(url),
                })
                .collect(),
        }
    }

    #[test]
    fn loops_the_local_entry_then_relays_then_directs() {
        let set = set(&[
            (HostEndpointRole::Direct, "wss://direct/"),
            (HostEndpointRole::Relay, "wss://relay/"),
        ]);
        let plan = candidate_plan("ws://127.0.0.1:7420/secure", Some(&set), None);
        assert_eq!(
            plan.iter()
                .map(|c| (c.role, c.url.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (RemoteCandidateRole::Loopback, "ws://127.0.0.1:7420/secure"),
                (RemoteCandidateRole::Relay, "wss://relay/"),
                (RemoteCandidateRole::Direct, "wss://direct/"),
            ]
        );
    }

    #[test]
    fn an_endpoint_set_replaces_a_non_loopback_legacy_url() {
        let relay_only = set(&[(HostEndpointRole::Relay, "wss://relay/")]);
        let plan = candidate_plan("wss://old/", Some(&relay_only), None);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].role, RemoteCandidateRole::Relay);

        let empty_set = set(&[]);
        assert!(candidate_plan("wss://old/", Some(&empty_set), None).is_empty());
    }

    #[test]
    fn legacy_fallback_and_first_role_wins() {
        let plan = candidate_plan("wss://old/", None, None);
        assert_eq!(plan[0].role, RemoteCandidateRole::Legacy);

        let duplicate = set(&[
            (HostEndpointRole::Direct, "wss://same/"),
            (HostEndpointRole::Relay, "wss://same/"),
        ]);
        let plan = candidate_plan("wss://old/", Some(&duplicate), None);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].role, RemoteCandidateRole::Relay);
    }

    #[test]
    fn https_pages_report_insecure_remote_candidates_as_unsupported() {
        let mixed = set(&[
            (HostEndpointRole::Relay, "ws://relay/"),
            (HostEndpointRole::Direct, "wss://direct/"),
        ]);
        let plan = candidate_plan("wss://old/", Some(&mixed), Some("https:"));
        assert_eq!(plan[0].unsupported.as_deref(), Some(MIXED_CONTENT_REASON));
        assert_eq!(plan[1].unsupported, None);
    }

    #[test]
    fn preferred_legacy_url_keeps_loopback_and_prefers_relay() {
        let current = "ws://127.0.0.1:7420/secure";
        assert_eq!(
            preferred_legacy_url(current, &set(&[(HostEndpointRole::Relay, "wss://relay/")])),
            current
        );
        assert_eq!(
            preferred_legacy_url(
                "wss://old/",
                &set(&[
                    (HostEndpointRole::Direct, "wss://direct/"),
                    (HostEndpointRole::Relay, "wss://relay/"),
                ])
            ),
            "wss://relay/"
        );
        assert_eq!(
            preferred_legacy_url(
                "wss://old/",
                &set(&[(HostEndpointRole::Direct, "wss://direct/")])
            ),
            "wss://direct/"
        );
        assert_eq!(preferred_legacy_url("wss://old/", &set(&[])), "wss://old/");
    }
}
