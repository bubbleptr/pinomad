// The UniFFI facade (ADR-0024 §2/§3): `PinomadClient` wraps the state
// machine in a Mutex so the platform layer can drive it from any thread.
// No `Json` crosses this boundary — calls, events, commands, and the
// delivered snapshot are all typed records and enums.
mod account;
mod calls;
mod functions;
mod hosts;
mod providers;
mod rtc;
mod snapshot;
mod types;

pub use account::*;
pub use calls::*;
pub use functions::*;
pub use hosts::*;
pub use providers::*;
pub use rtc::*;
pub use snapshot::*;
pub use types::*;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::remote_candidates::candidate_plan;
use crate::remote_durable::{Command, Event, PlannedSource, RemoteDurable, RemoteDurableOptions};

/// How a Request-class op's `OperationSucceeded` value decodes. Command and
/// Unqueued ops always map to `CallResult::Unit`.
#[derive(Clone, Copy)]
pub(crate) enum ResultKind {
    Project,
    FolderListing,
    Changes,
    Files,
    Pairing,
    Skills,
    Image,
    Commands,
    BeginAttachment,
    AppendAttachment,
    WithdrawQueued,
    SteerQueued,
    LoginStarted,
    EndpointModels,
}

/// State behind the single lock: the machine plus the op→result-shape map
/// `Invoke` leaves behind.
struct Inner {
    remote: RemoteDurable,
    result_kinds: HashMap<u64, ResultKind>,
}

/// The client object Swift drives. Every call/event goes in serialized on
/// the mutex and every command comes out as a return value — there is no
/// callback, because every command the core can emit is produced by some
/// `handle`/`take` call, and returning them dodges callback re-entrancy and
/// threading questions at the boundary.
///
/// Failure contract, following the reference `RemoteDurable` exactly:
/// - Request-class calls (`addProject`, `listFolders`, `renameConversation`,
///   `setPushToken`, `changes`, `createPairing`, and the provider calls
///   `beginLogin` … `listEndpointModels`) reject the op: the platform sees
///   `OperationFailed { op, error }`.
/// - Command-class calls (everything else: `submit`, `switchConversation`,
///   `createConversation`, `archive`, `compact`, `runCommand`, `answer`, `setModel`,
///   `setThinkingLevel`, `setAgent`, `revokeDevice`, `logout`, `updateSettings`) and the
///   unqueued `abort` still emit
///   `OperationSucceeded { value: Unit }` on failure — the reason lands as
///   an entry in `snapshot().notices` with a stable `id`, like a host
///   `notice` frame.
#[derive(uniffi::Object)]
pub struct PinomadClient {
    inner: Mutex<Inner>,
}

impl PinomadClient {
    fn new(remote: RemoteDurable) -> Self {
        PinomadClient {
            inner: Mutex::new(Inner {
                remote,
                result_kinds: HashMap::new(),
            }),
        }
    }

    /// Rust-side constructor for the test harnesses: any `Transport`, the
    /// same options RemoteDurable takes. The FFI surface only offers the
    /// two real connection modes (`pair`, `connect`).
    pub fn with_options(options: RemoteDurableOptions) -> Self {
        Self::new(RemoteDurable::new(options))
    }

    fn convert_commands(&self, commands: Vec<Command>, inner: &mut Inner) -> Vec<FfiCommand> {
        commands
            .into_iter()
            .map(|command| match command {
                Command::OpenConnection { conn, url } => {
                    FfiCommand::OpenConnection { conn: conn as u64, url }
                }
                Command::SendBytes { conn, bytes } => FfiCommand::SendBytes { conn: conn as u64, bytes },
                Command::CloseSocket { conn } => FfiCommand::CloseSocket { conn: conn as u64 },
                Command::ScheduleReconnect { timer, delay_ms } => {
                    FfiCommand::ScheduleReconnect { timer: timer as u64, delay_ms }
                }
                Command::CancelReconnect { timer } => FfiCommand::CancelReconnect { timer: timer as u64 },
                Command::ScheduleDeadline { timer, delay_ms } => {
                    FfiCommand::ScheduleDeadline { timer: timer as u64, delay_ms }
                }
                Command::CancelDeadline { timer } => FfiCommand::CancelDeadline { timer: timer as u64 },
                Command::Ready { outcome } => FfiCommand::Ready { outcome: outcome.into() },
                Command::ViewChanged => FfiCommand::ViewChanged,
                Command::CandidateFailed { failure } => FfiCommand::CandidateFailed {
                    failure: CandidateFailure::from_core(&failure),
                },
                Command::EndpointSet { host_key, url, endpoint_set } => FfiCommand::EndpointSet {
                    host_key,
                    url,
                    endpoint_set: EndpointSet::from_core(&endpoint_set),
                },
                Command::Paired { url, host_key, private_key, endpoint_set } => FfiCommand::Paired {
                    host: StoredHost {
                        url,
                        host_key,
                        private_key,
                        name: None,
                        account: None,
                        endpoint_set: endpoint_set.as_ref().map(EndpointSet::from_core),
                        connection_mode: None,
                        rtc_signal_only: None,
                    },
                },
                Command::OperationSucceeded { op, value } => {
                    match inner.result_kinds.remove(&op) {
                        Some(ResultKind::Project) => FfiCommand::OperationSucceeded {
                            op,
                            value: CallResult::Project { project: project_of(value.as_ref()) },
                        },
                        Some(ResultKind::FolderListing) => FfiCommand::OperationSucceeded {
                            op,
                            value: CallResult::FolderListing { listing: folder_listing_of(value.as_ref()) },
                        },
                        // A changes result that doesn't fit the wire union
                        // fails the op rather than delivering a guess.
                        Some(ResultKind::Changes) => match changes_of(value.as_ref()) {
                            Ok(changes) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Changes { changes },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::Files) => match files_of(value.as_ref()) {
                            Ok((files, truncated)) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Files { files, truncated },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::Skills) => match skills_of(value.as_ref()) {
                            Ok(skills) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Skills { skills },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::Image) => match image_of(value.as_ref()) {
                            Ok(image) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Image { image },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::Commands) => match commands_of(value.as_ref()) {
                            Ok(commands) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Commands { commands },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::BeginAttachment) => match begin_attachment_of(value.as_ref()) {
                            Ok(attachment_id) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::BeginAttachment { attachment_id },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::AppendAttachment) => match append_attachment_of(value.as_ref()) {
                            Ok((received, complete)) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::AppendAttachment { received, complete },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::Pairing) => match pairing_of(value.as_ref()) {
                            Ok((url, expires_at)) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Pairing { url, expires_at },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::WithdrawQueued) => match withdraw_outcome_of(value.as_ref()) {
                            Ok(outcome) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::WithdrawQueued { outcome },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::SteerQueued) => match steer_outcome_of(value.as_ref()) {
                            Ok(outcome) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::SteerQueued { outcome },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::LoginStarted) => match login_started_of(value.as_ref()) {
                            Ok(login_id) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::LoginStarted { login_id },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        Some(ResultKind::EndpointModels) => match endpoint_models_of(value.as_ref()) {
                            Ok(models) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::EndpointModels { models },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error, carrier_lost: false },
                        },
                        None => FfiCommand::OperationSucceeded { op, value: CallResult::Unit },
                    }
                }
                Command::OperationFailed { op, error, carrier_lost } => {
                    inner.result_kinds.remove(&op);
                    FfiCommand::OperationFailed { op, error, carrier_lost }
                }
                Command::RtcSignalOnly { host_key, signal_only } => {
                    FfiCommand::RtcSignalOnly { host_key, signal_only }
                }
                Command::CreateRtcPeer { peer, stun } => {
                    FfiCommand::CreateRtcPeer { peer: peer as u64, stun }
                }
                Command::AcceptRtcAnswer { peer, sdp } => {
                    FfiCommand::AcceptRtcAnswer { peer: peer as u64, sdp }
                }
                Command::RtcSend { peer, bytes } => {
                    FfiCommand::RtcSend { peer: peer as u64, bytes }
                }
                Command::CloseRtcPeer { peer } => FfiCommand::CloseRtcPeer { peer: peer as u64 },
            })
            .collect()
    }
}

/// A source that can open both a business carrier and the signal-only one.
/// They share the device key and the one-time pairing state; only the
/// prologue differs.
struct RtcCandidateSource {
    business: PlannedSource,
    signal: PlannedSource,
}

impl crate::remote_durable::CandidateSource for RtcCandidateSource {
    fn open(
        &mut self,
        candidate: &crate::remote_candidates::RemoteCandidate,
    ) -> Box<dyn crate::transport::Connection> {
        self.business.open(candidate)
    }

    fn open_signal(
        &mut self,
        candidate: &crate::remote_candidates::RemoteCandidate,
    ) -> Box<dyn crate::transport::Connection> {
        self.signal.open(candidate)
    }

    fn mark_paired(&mut self) -> Option<(String, String, String)> {
        self.business.mark_paired()
    }
}

fn candidate_options(
    url: &str,
    endpoint_set: Option<&crate::endpoints::EndpointSet>,
    host_key: &str,
    private_key: &str,
    pairing: Option<crate::secure_channel::Pairing>,
    connection_mode: crate::connection_mode::ConnectionMode,
    rtc: Option<crate::remote_durable::RtcOptions>,
) -> RemoteDurableOptions {
    use crate::secure_channel::{PairingState, SecureTransport, UnavailableTransport};

    let candidates = candidate_plan(url, endpoint_set, None);
    let pairing_state = PairingState::new(pairing);
    let host_key = host_key.to_string();
    let private_key = private_key.to_string();

    let factory = |signal: bool, host_key: String, private_key: String, state: PairingState| {
        PlannedSource::new(Box::new(
            move |candidate: &crate::remote_candidates::RemoteCandidate| {
                match SecureTransport::with_pairing_state(
                    &candidate.url,
                    &host_key,
                    &private_key,
                    state.clone(),
                ) {
                    Ok(transport) => Box::new(if signal {
                        transport.with_signal_prologue()
                    } else {
                        transport
                    }),
                    Err(error) => Box::new(UnavailableTransport {
                        url: candidate.url.clone(),
                        reason: error.to_string(),
                    }),
                }
            },
        ))
    };
    let business = factory(
        false,
        host_key.clone(),
        private_key.clone(),
        pairing_state.clone(),
    );
    let source: Box<dyn crate::remote_durable::CandidateSource> = if rtc.is_some() {
        let signal = factory(true, host_key.clone(), private_key, pairing_state);
        Box::new(RtcCandidateSource { business, signal })
    } else {
        Box::new(business)
    };
    RemoteDurableOptions {
        source,
        mode: crate::remote_durable::RemoteMode::Planned,
        reconnect_delay_ms: None,
        request_id: None,
        candidates,
        legacy_url: Some(url.to_string()),
        page_protocol: None,
        host_key,
        pairing_endpoint_set: endpoint_set.cloned(),
        candidate_timeouts: Default::default(),
        round_timeout_ms: None,
        connection_mode,
        rtc,
        // PR 2 keeps the native behavior: iOS opts in with its UI in #406.
        logical_submissions: false,
    }
}

#[uniffi::export]
impl PinomadClient {
    /// Pair a new device: `link` is the scanned `pinomad://…#pair=…` URL,
    /// `device_name` travels in the pairing offer for the host's Devices
    /// list. `device_private_key` (base64url) reuses the stored key when
    /// re-pairing a host this device was once registered on — a fresh
    /// identity is generated when absent.
    ///
    /// After this call the platform takes the commands from `take()` and
    /// drives the socket; the completed pairing arrives as
    /// `FfiCommand::Paired` — that payload is what the keychain stores.
    #[uniffi::constructor]
    pub fn pair(
        link: String,
        device_name: String,
        device_private_key: Option<String>,
    ) -> Result<Arc<Self>, ClientError> {
        let parsed = crate::pairing_link::parse_pairing_link(&link)
            .ok_or(ClientError::InvalidPairingLink)?;
        let private = match device_private_key {
            Some(key) => key,
            None => crate::secure_channel::SecureTransport::new_device()
                .map_err(|e| ClientError::KeyMaterial { message: e.to_string() })?
                .1,
        };
        let host_key = crate::b64::to_base64url(&parsed.host_key);
        // Validate reused and fresh key material before any candidate opens:
        // the old contract returned ClientError::KeyMaterial immediately.
        crate::secure_channel::SecureTransport::new(&parsed.url, &host_key, &private, None)
            .map_err(|error| ClientError::KeyMaterial { message: error.to_string() })?;
        let options = candidate_options(
            &parsed.url,
            parsed.endpoint_set.as_ref(),
            &host_key,
            &private,
            Some(crate::secure_channel::Pairing {
                secret: parsed.secret,
                name: device_name,
            }),
            crate::connection_mode::ConnectionMode::Auto,
            Some(crate::remote_durable::RtcOptions {
                host_key: host_key.clone(),
                device_private_key: private.clone(),
                signal_only_hint: false,
            }),
        );
        Ok(Arc::new(Self::new(RemoteDurable::new(options))))
    }

    /// Reconnect to a stored host — `host` is the record the keychain kept
    /// (run it through `validate_stored_host` after reading it back).
    #[uniffi::constructor]
    pub fn connect(host: StoredHost) -> Result<Arc<Self>, ClientError> {
        let host = validate_stored_host(host)
            .map_err(|error| ClientError::InvalidStoredHost { message: error.to_string() })?;
        let endpoint_set = host.endpoint_set.as_ref().and_then(EndpointSet::to_core);
        let connection_mode = match host.connection_mode.as_deref() {
            Some("directOnly") => crate::connection_mode::ConnectionMode::DirectOnly,
            Some("relayOnly") => crate::connection_mode::ConnectionMode::RelayOnly,
            _ => crate::connection_mode::ConnectionMode::Auto,
        };
        let options = candidate_options(
            &host.url,
            endpoint_set.as_ref(),
            &host.host_key,
            &host.private_key,
            None,
            connection_mode,
            Some(crate::remote_durable::RtcOptions {
                host_key: host.host_key.clone(),
                device_private_key: host.private_key.clone(),
                signal_only_hint: host.rtc_signal_only.unwrap_or(false),
            }),
        );
        Ok(Arc::new(Self::new(RemoteDurable::new(options))))
    }

    /// The constructor's first commands — the initial `OpenConnection`
    /// waits here, before any `handle`.
    pub fn take(&self) -> Vec<FfiCommand> {
        let mut inner = self.inner.lock().expect("client poisoned");
        let commands = inner.remote.take();
        self.convert_commands(commands, &mut inner)
    }

    /// One event in, the commands it produced out. `Invoke` carries the
    /// platform's op id plus a typed `FfiCall`.
    pub fn handle(&self, event: FfiEvent) -> Vec<FfiCommand> {
        let mut inner = self.inner.lock().expect("client poisoned");
        let event = match event {
            FfiEvent::SocketOpened { conn } => Event::SocketOpened { conn: conn as u32 },
            FfiEvent::SocketData { conn, bytes } => Event::SocketData { conn: conn as u32, bytes },
            FfiEvent::SocketClosed { conn, code, reason } => {
                Event::SocketClosed { conn: conn as u32, code, reason }
            }
            FfiEvent::SendFailed { conn } => Event::SendFailed { conn: conn as u32 },
            FfiEvent::TimerFired { timer } => Event::TimerFired { timer: timer as u32 },
            FfiEvent::Invoke { op, call } => {
                if let Some(kind) = call.result_kind() {
                    inner.result_kinds.insert(op, kind);
                }
                Event::Invoke {
                    op,
                    call: call.into_core(),
                }
            }
            FfiEvent::Close => Event::Close,
            FfiEvent::Foreground => Event::Foreground,
            FfiEvent::Background => Event::Background,
            FfiEvent::NetworkChanged => Event::NetworkChanged,
            FfiEvent::Clock { now_ms } => Event::Clock { now_ms },
            FfiEvent::RtcPeerReady { peer, sdp } => Event::RtcPeerReady { peer: peer as u32, sdp },
            FfiEvent::RtcChannelOpened { peer } => Event::RtcChannelOpened { peer: peer as u32 },
            FfiEvent::RtcData { peer, bytes } => Event::RtcData { peer: peer as u32, bytes },
            FfiEvent::RtcSendResult { peer, outcome } => Event::RtcSendResult {
                peer: peer as u32,
                outcome: match outcome {
                    RtcSendOutcome::Accepted => crate::remote_durable::RtcSendOutcome::Accepted,
                    RtcSendOutcome::Rejected => crate::remote_durable::RtcSendOutcome::Rejected,
                },
            },
            FfiEvent::RtcLowWater { peer } => Event::RtcLowWater { peer: peer as u32 },
            FfiEvent::RtcClosed { peer, reason } => Event::RtcClosed { peer: peer as u32, reason },
            FfiEvent::RtcSelectedCandidate { peer, local, remote } => {
                Event::RtcSelectedCandidate {
                    peer: peer as u32,
                    local: local.into_core(),
                    remote: remote.into_core(),
                }
            }
        };
        let commands = inner.remote.handle(event);
        self.convert_commands(commands, &mut inner)
    }

    /// The whole UI state at one version, computed under a single lock so
    /// every field agrees.
    ///
    /// Coalescing lives on the platform side: `ViewChanged` only marks the
    /// view dirty — the expensive derivation here should happen once per
    /// merged update, after the burst settles. `ViewChanged` is the only
    /// command that may be coalesced away: socket events, timers, and
    /// `OperationSucceeded`/`OperationFailed` must always be delivered
    /// (network input and op completions are never merge-dropped).
    pub fn snapshot(&self) -> Option<ClientSnapshot> {
        let inner = self.inner.lock().expect("client poisoned");
        snapshot::build(&inner.remote)
    }

    /// The original text and images of a queued steer/follow-up, or `None` for
    /// a write or an unknown id. Read on demand from the current view — images
    /// stay out of every `ConversationSnapshot` (the Edit affordance is rare;
    /// the per-update FFI copy is not).
    pub fn queued_input(&self, submission_id: u64) -> Option<QueuedInput> {
        let inner = self.inner.lock().expect("client poisoned");
        let view = inner.remote.view()?;
        let conversation = view.get("conversation")?;
        crate::chat::queued_input(conversation, submission_id)
    }

    /// The connection-mode page's status. A pure read of the core under the
    /// lock, like `snapshot()`; the platform feeds a Clock event first when
    /// it wants cooldowns measured from now.
    pub fn rtc_diagnostics(&self) -> RtcDiagnostics {
        let inner = self.inner.lock().expect("client poisoned");
        RtcDiagnostics::from_json(&inner.remote.rtc_diagnostics())
    }
}

// The facade must stay sendable across threads for UniFFI's handle map.
const _: () = {
    const fn bound<T: Send + Sync>() {}
    bound::<PinomadClient>();
};
