// The RTC engine at the UniFFI boundary. Swift owns the UDP socket, the
// clock, and the name resolution; this object only turns one synchronous
// call into datagrams/deadlines/events and back. Everything it returns is
// data, so the session loop can keep its single ordered queue.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use crate::ffi::ClientError;
use crate::json::Json;
use pinomad_rtc::{Action, Engine, EngineConfig, SendOutcome};

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
        kind: String,
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
            Action::SelectedCandidate { kind } => RtcAction::SelectedCandidate { kind },
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
    /// The selected ICE pair's candidate types, e.g. `host ↔ srflx`.
    pub selected_candidate_type: Option<String>,
    pub cooldown_remaining_ms: u64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RtcFailure {
    pub stage: String,
    pub reason: String,
}

impl RtcDiagnostics {
    pub(crate) fn from_json(value: &Json) -> Self {
        let text = |key: &str| value.get(key).and_then(Json::as_str).map(|s| s.to_string_lossy());
        RtcDiagnostics {
            path: text("path").unwrap_or_else(|| "loopback".to_string()),
            phase: text("phase").unwrap_or_else(|| "idle".to_string()),
            available: value.get("available").is_some_and(Json::truthy),
            last_failure: value.get("lastFailure").and_then(|failure| {
                Some(RtcFailure {
                    stage: failure.get("stage").and_then(Json::as_str).map(|s| s.to_string_lossy())?,
                    reason: failure.get("reason").and_then(Json::as_str).map(|s| s.to_string_lossy())?,
                })
            }),
            selected_candidate_type: text("selectedCandidateType"),
            cooldown_remaining_ms: value
                .get("cooldownRemainingMs")
                .and_then(Json::as_number)
                .filter(|ms| ms.is_finite() && *ms >= 0.0)
                .map(|ms| ms as u64)
                .unwrap_or(0),
        }
    }
}
