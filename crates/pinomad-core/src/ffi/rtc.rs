// The RTC engine at the UniFFI boundary. Swift owns the UDP socket, the
// clock, and the name resolution; this object only turns one synchronous
// call into datagrams/deadlines/events and back. Everything it returns is
// data, so the session loop can keep its single ordered queue.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use crate::ffi::ClientError;
use crate::json::Json;
use pinomad_rtc::{Action, Engine, EngineConfig, SelectedCandidateEnd, SendOutcome};

/// One end of a selected ICE pair, as the engine reported it: the library's
/// candidate type and the socket address the pair uses. Scope is classified
/// by the core, not here.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RtcSelectedCandidateEnd {
    pub kind: String,
    pub address: String,
}

impl From<SelectedCandidateEnd> for RtcSelectedCandidateEnd {
    fn from(end: SelectedCandidateEnd) -> Self {
        RtcSelectedCandidateEnd {
            kind: end.kind,
            address: end.address.to_string(),
        }
    }
}

impl RtcSelectedCandidateEnd {
    /// Back to the core's raw pair end; classification stays in the core.
    pub(crate) fn into_core(self) -> crate::rtc::RtcCandidateInfo {
        crate::rtc::RtcCandidateInfo {
            rtc_type: Some(self.kind),
            address: Some(self.address),
        }
    }
}

/// One thing the platform must do after an engine call.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum RtcAction {
    Transmit {
        destination: String,
        bytes: Vec<u8>,
    },
    /// Arm this Peer's timer for the absolute monotonic millisecond.
    Schedule {
        at_ms: u64,
    },
    LocalOffer {
        sdp: String,
    },
    ChannelOpened,
    Data {
        bytes: Vec<u8>,
    },
    BufferedAmountLow,
    SelectedCandidate {
        local: RtcSelectedCandidateEnd,
        remote: RtcSelectedCandidateEnd,
    },
    Closed {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RtcSendOutcome {
    Accepted,
    Rejected,
}

/// `send`'s verdict plus the datagrams it produced (str0m writes can flush
/// data). The platform reports the outcome back as `FfiEvent::RtcSendResult`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RtcWrite {
    pub outcome: RtcSendOutcome,
    pub actions: Vec<RtcAction>,
}

impl From<Action> for RtcAction {
    fn from(action: Action) -> Self {
        match action {
            Action::Transmit { destination, bytes } => RtcAction::Transmit {
                destination: destination.to_string(),
                bytes,
            },
            Action::Schedule { at_ms } => RtcAction::Schedule { at_ms },
            Action::LocalOffer { sdp } => RtcAction::LocalOffer { sdp },
            Action::ChannelOpened => RtcAction::ChannelOpened,
            Action::Data { bytes } => RtcAction::Data { bytes },
            Action::BufferedAmountLow => RtcAction::BufferedAmountLow,
            Action::SelectedCandidate { local, remote } => RtcAction::SelectedCandidate {
                local: local.into(),
                remote: remote.into(),
            },
            Action::Closed { reason } => RtcAction::Closed { reason },
        }
    }
}

fn actions(actions: Vec<Action>) -> Vec<RtcAction> {
    actions.into_iter().map(RtcAction::from).collect()
}

fn address(text: &str) -> Result<SocketAddr, ClientError> {
    text.parse().map_err(|_| ClientError::RtcAddress {
        message: format!("{text} is not an IP:port address"),
    })
}

/// One Peer: offer, answer, ICE, DTLS and the DataChannel. Dropping it is
/// enough to release str0m's state; `close` also records the intent so late
/// sends are rejected instead of queued.
#[derive(uniffi::Object)]
pub struct RtcPeer {
    inner: Mutex<Engine>,
}

#[uniffi::export]
impl RtcPeer {
    #[uniffi::constructor]
    pub fn new(
        local_addr: String,
        stun_servers: Vec<String>,
        now_ms: u64,
    ) -> Result<Arc<Self>, ClientError> {
        let local = address(&local_addr)?;
        let servers = stun_servers
            .iter()
            .map(|server| address(server))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Arc::new(RtcPeer {
            inner: Mutex::new(Engine::new(
                EngineConfig {
                    local_addr: local,
                    stun_servers: servers,
                },
                now_ms,
            )),
        }))
    }

    pub fn start(&self, now_ms: u64) -> Vec<RtcAction> {
        actions(self.engine().start(now_ms))
    }

    pub fn accept_answer(&self, now_ms: u64, sdp: String) -> Vec<RtcAction> {
        actions(self.engine().accept_answer(now_ms, &sdp))
    }

    pub fn receive(&self, now_ms: u64, source: String, bytes: Vec<u8>) -> Vec<RtcAction> {
        let Ok(source) = source.parse::<SocketAddr>() else {
            return Vec::new();
        };
        actions(self.engine().receive(now_ms, source, &bytes))
    }

    pub fn timeout(&self, now_ms: u64) -> Vec<RtcAction> {
        actions(self.engine().timeout(now_ms))
    }

    pub fn send(&self, now_ms: u64, bytes: Vec<u8>) -> RtcWrite {
        let (outcome, produced) = self.engine().send(now_ms, &bytes);
        RtcWrite {
            outcome: match outcome {
                SendOutcome::Accepted => RtcSendOutcome::Accepted,
                SendOutcome::Rejected => RtcSendOutcome::Rejected,
            },
            actions: actions(produced),
        }
    }

    /// Ask the engine to retire. No `Closed` action comes back: the caller
    /// already knows, and the coordinator must not treat it as a failure.
    pub fn close(&self) {
        self.engine().close();
    }
}

impl RtcPeer {
    fn engine(&self) -> std::sync::MutexGuard<'_, Engine> {
        self.inner.lock().expect("rtc engine poisoned")
    }
}

/// A candidate's network scope, classified by the core (issue #385).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RtcAddressScope {
    Loopback,
    Lan,
    Tailnet,
    Public,
    Unknown,
}

impl RtcAddressScope {
    fn from_json(value: Option<&Json>) -> Self {
        match value
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .as_deref()
        {
            Some("loopback") => RtcAddressScope::Loopback,
            Some("lan") => RtcAddressScope::Lan,
            Some("tailnet") => RtcAddressScope::Tailnet,
            Some("public") => RtcAddressScope::Public,
            _ => RtcAddressScope::Unknown,
        }
    }
}

/// One end of the selected pair as the coordinator classified it.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RtcCandidateEnd {
    /// The ICE candidate type, e.g. `host` or `srflx`.
    pub rtc_type: Option<String>,
    pub address: Option<String>,
    pub scope: RtcAddressScope,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RtcSelectedPair {
    pub local: RtcCandidateEnd,
    pub remote: RtcCandidateEnd,
}

/// The connection-mode page's status (ADR-0033 §5). Typed so Swift never
/// parses the coordinator's JSON.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RtcDiagnostics {
    /// `loopback` | `relay` | `direct` | `p2p`.
    pub path: String,
    /// `signal` | `ice` | `noise` | `warm` | `active` | `cooldown` |
    /// `scheduled` | `idle`.
    pub phase: String,
    /// Whether the connected host advertised WebRTC.
    pub available: bool,
    pub last_failure: Option<RtcFailure>,
    /// The active ICE pair's ends, with the core's address classification.
    pub selected_pair: Option<RtcSelectedPair>,
    pub cooldown_remaining_ms: u64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RtcFailure {
    pub stage: String,
    pub reason: String,
    /// Milliseconds between the failure and this diagnostics read.
    pub ago_ms: u64,
    /// The pair in use when it failed; absent before ICE selected one.
    pub pair: Option<RtcSelectedPair>,
}

fn text(value: &Json) -> Option<String> {
    value.as_str().map(|s| s.to_string_lossy())
}

fn candidate_end(value: &Json) -> RtcCandidateEnd {
    RtcCandidateEnd {
        rtc_type: value.get("type").and_then(text),
        address: value.get("address").and_then(text),
        scope: RtcAddressScope::from_json(value.get("scope")),
    }
}

fn selected_pair(value: &Json) -> Option<RtcSelectedPair> {
    let local = value.get("local").filter(|end| end.is_object())?;
    let remote = value.get("remote").filter(|end| end.is_object())?;
    Some(RtcSelectedPair {
        local: candidate_end(local),
        remote: candidate_end(remote),
    })
}

impl RtcDiagnostics {
    pub(crate) fn from_json(value: &Json) -> Self {
        RtcDiagnostics {
            path: value
                .get("path")
                .and_then(Json::as_str)
                .map(|s| s.to_string_lossy())
                .unwrap_or_else(|| "loopback".to_string()),
            phase: value
                .get("phase")
                .and_then(Json::as_str)
                .map(|s| s.to_string_lossy())
                .unwrap_or_else(|| "idle".to_string()),
            available: value.get("available").is_some_and(Json::truthy),
            last_failure: value.get("lastFailure").and_then(|failure| {
                Some(RtcFailure {
                    stage: failure.get("stage").and_then(text)?,
                    reason: failure.get("reason").and_then(text)?,
                    ago_ms: failure
                        .get("agoMs")
                        .and_then(Json::as_number)
                        .filter(|ms| ms.is_finite() && *ms >= 0.0)
                        .map(|ms| ms as u64)
                        .unwrap_or(0),
                    pair: failure.get("pair").and_then(selected_pair),
                })
            }),
            selected_pair: value.get("selectedPair").and_then(selected_pair),
            cooldown_remaining_ms: value
                .get("cooldownRemainingMs")
                .and_then(Json::as_number)
                .filter(|ms| ms.is_finite() && *ms >= 0.0)
                .map(|ms| ms as u64)
                .unwrap_or(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_candidate_action_keeps_both_ends() {
        let action = Action::SelectedCandidate {
            local: SelectedCandidateEnd {
                kind: "host".to_string(),
                address: "10.0.0.2:5000".parse().expect("local address"),
            },
            remote: SelectedCandidateEnd {
                kind: "srflx".to_string(),
                address: "100.64.1.2:6000".parse().expect("remote address"),
            },
        };
        match RtcAction::from(action) {
            RtcAction::SelectedCandidate { local, remote } => {
                assert_eq!(local.kind, "host");
                assert_eq!(local.address, "10.0.0.2:5000");
                assert_eq!(remote.kind, "srflx");
                assert_eq!(remote.address, "100.64.1.2:6000");
            }
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn diagnostics_parse_the_classified_pair_and_frozen_failure() {
        let value = Json::parse(
            r#"{
                "path": "p2p",
                "phase": "cooldown",
                "available": true,
                "selectedPair": {
                    "local": {"type": "host", "address": "10.0.0.2:5000", "scope": "lan"},
                    "remote": {"type": "srflx", "address": "100.64.1.2:6000", "scope": "tailnet"}
                },
                "lastFailure": {
                    "stage": "liveness",
                    "reason": "the ICE connection failed",
                    "agoMs": 7000,
                    "pair": {
                        "local": {"type": "host", "address": "10.0.0.2:5000", "scope": "lan"},
                        "remote": {"type": "srflx", "address": "100.64.1.2:6000", "scope": "tailnet"}
                    }
                },
                "cooldownRemainingMs": 53000
            }"#,
        )
        .expect("diagnostics JSON");

        let diagnostics = RtcDiagnostics::from_json(&value);
        let selected = diagnostics.selected_pair.expect("active pair");
        assert_eq!(selected.local.rtc_type.as_deref(), Some("host"));
        assert_eq!(selected.local.address.as_deref(), Some("10.0.0.2:5000"));
        assert_eq!(selected.local.scope, RtcAddressScope::Lan);
        assert_eq!(selected.remote.scope, RtcAddressScope::Tailnet);

        let failure = diagnostics.last_failure.expect("recorded failure");
        assert_eq!(failure.stage, "liveness");
        assert_eq!(failure.reason, "the ICE connection failed");
        assert_eq!(failure.ago_ms, 7000);
        assert_eq!(
            failure.pair.expect("failure pair").remote.scope,
            RtcAddressScope::Tailnet
        );
        assert_eq!(diagnostics.cooldown_remaining_ms, 53000);
    }
}
