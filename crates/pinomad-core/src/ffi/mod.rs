// The UniFFI facade (ADR-0024 §2/§3): `PinomadClient` wraps the state
// machine in a Mutex so the platform layer can drive it from any thread.
// No `Json` crosses this boundary — calls, events, commands, and the
// delivered snapshot are all typed records and enums.
mod account;
mod calls;
mod functions;
mod hosts;
mod snapshot;
mod types;

pub use account::*;
pub use calls::*;
pub use functions::*;
pub use hosts::*;
pub use snapshot::*;
pub use types::*;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::remote_durable::{Command, Event, RemoteDurable, RemoteDurableOptions};

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
    WithdrawQueued,
    SteerQueued,
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
///   `setPushToken`, `changes`, `createPairing`) reject the op: the platform
///   sees `OperationFailed { op, error }`.
/// - Command-class calls (everything else: `submit`, `switchConversation`,
///   `createConversation`, `archive`, `compact`, `answer`, `setModel`,
///   `setThinkingLevel`, `revokeDevice`, `updateSettings`) and the
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
                Command::Ready { outcome } => FfiCommand::Ready { outcome: outcome.into() },
                Command::ViewChanged => FfiCommand::ViewChanged,
                Command::Paired { url, host_key, private_key } => {
                    FfiCommand::Paired { url, host_key, private_key }
                }
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
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        Some(ResultKind::Files) => match files_of(value.as_ref()) {
                            Ok((files, truncated)) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Files { files, truncated },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        Some(ResultKind::Skills) => match skills_of(value.as_ref()) {
                            Ok(skills) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Skills { skills },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        Some(ResultKind::Image) => match image_of(value.as_ref()) {
                            Ok(image) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Image { image },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        Some(ResultKind::Pairing) => match pairing_of(value.as_ref()) {
                            Ok((url, expires_at)) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::Pairing { url, expires_at },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        Some(ResultKind::WithdrawQueued) => match withdraw_outcome_of(value.as_ref()) {
                            Ok(outcome) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::WithdrawQueued { outcome },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        Some(ResultKind::SteerQueued) => match steer_outcome_of(value.as_ref()) {
                            Ok(outcome) => FfiCommand::OperationSucceeded {
                                op,
                                value: CallResult::SteerQueued { outcome },
                            },
                            Err(error) => FfiCommand::OperationFailed { op, error },
                        },
                        None => FfiCommand::OperationSucceeded { op, value: CallResult::Unit },
                    }
                }
                Command::OperationFailed { op, error } => {
                    inner.result_kinds.remove(&op);
                    FfiCommand::OperationFailed { op, error }
                }
            })
            .collect()
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
        let transport = crate::secure_channel::SecureTransport::new(
            &parsed.url,
            &crate::b64::to_base64url(&parsed.host_key),
            &private,
            Some(crate::secure_channel::Pairing {
                secret: parsed.secret,
                name: device_name,
            }),
        )
        .map_err(|e| ClientError::KeyMaterial { message: e.to_string() })?;
        Ok(Arc::new(Self::new(RemoteDurable::new(RemoteDurableOptions {
            transport: Box::new(transport),
            reconnect_delay_ms: None,
            request_id: None,
        }))))
    }

    /// Reconnect to a stored host — `host` is the record the keychain kept
    /// (run it through `validate_stored_host` after reading it back).
    #[uniffi::constructor]
    pub fn connect(host: StoredHost) -> Result<Arc<Self>, ClientError> {
        let transport = crate::secure_channel::SecureTransport::new(
            &host.url,
            &host.host_key,
            &host.private_key,
            None,
        )
        .map_err(|e| ClientError::KeyMaterial { message: e.to_string() })?;
        Ok(Arc::new(Self::new(RemoteDurable::new(RemoteDurableOptions {
            transport: Box::new(transport),
            reconnect_delay_ms: None,
            request_id: None,
        }))))
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
}

// The facade must stay sendable across threads for UniFFI's handle map.
const _: () = {
    const fn bound<T: Send + Sync>() {}
    bound::<PinomadClient>();
};
