// `PinomadClient::snapshot` — the whole UI state at one version, decoded
// out of the Json view in a single pass. The core derivations still run on
// the Json the stream carries; this file just shapes the delivery.

use crate::chat::{agent_of, queue_items, status_text};
use crate::cot_view::ChatEntry;
use crate::ffi::providers::{providers_of, HostProviders};
use crate::ffi::upgrade::{auto_upgrade_of, upgrade_of, AutoUpgradeMode, HostUpgradeState};
use crate::ffi::types::*;
use crate::json::{Json, JsonObject};
use crate::u16str::U16String;
use crate::model::ModelRef;
use crate::questions::pending_questions;
use crate::remote_durable::RemoteDurable;
use crate::transcript::is_busy;

/// Everything the interface renders, at `version`. `None` until the first
/// view arrives (`ReadyOutcome::Connected`).
#[derive(Clone, Debug, uniffi::Record)]
pub struct ClientSnapshot {
    /// The `ViewChanged` count — Swift coalesces bursts and reads exactly
    /// one consistent version.
    pub version: u64,
    pub connection: ConnectionState,
    /// Set when the host closed this device with 4401; terminal.
    pub unauthorized: bool,
    /// Present exactly when `connection` is `Outdated`.
    pub protocol_mismatch: Option<ProtocolMismatch>,
    /// What the host announced in its hello.
    pub host: Option<HostInfo>,
    /// The machine name the host announced on its settings stream (5.12).
    /// `None` until the stream lands, on older hosts, and when the field is
    /// missing or not a string — the platform keeps its cached name then.
    pub host_name: Option<String>,
    /// The settings stream's switches the settings page edits — `None`
    /// until the stream lands or when the host doesn't serve it.
    pub settings: Option<HostSettingsState>,
    /// The devices paired with this host (the `devices` stream), in the
    /// host's order.
    pub devices: Vec<DeviceEntry>,
    /// Chats and projects with their conversations, grouped for navigation.
    pub organized: Organized,
    /// Command failures land here with a stable, increasing id — the
    /// surfaced reason when `OperationSucceeded { value: Unit }` reports a
    /// refused Command-class call.
    pub notices: Vec<Notice>,
    /// The host's available models (`models` stream once arrived, else the
    /// hello's list).
    pub models: Vec<ModelSummary>,
    /// New-conversation defaults — `settings` stream when present.
    pub defaults: Defaults,
    /// Named agents on the host (ADR-0023) — `None` before the `agents`
    /// stream's snapshot or when the host predates it (5.6).
    pub agents: Option<AgentRoles>,
    /// The shown conversation and everything its screen reads.
    pub conversation: Option<ConversationSnapshot>,
    /// Every provider and the logins in progress (ADR-0031) — `None` before
    /// the `providers` stream's snapshot or when the host predates it (5.21).
    #[uniffi(default = None)]
    pub providers: Option<HostProviders>,
    /// Release checks and the upgrade in progress (ADR-0043) — `None` before
    /// the `upgrade` stream's snapshot or when the host predates it (5.30).
    /// Kept while reconnecting, so an `Installing` phase explains the drop.
    #[uniffi(default = None)]
    pub upgrade: Option<HostUpgradeState>,
    /// The overview's watched family process list (ADR-0045); `None` until
    /// `WatchProcesses` starts it. Kept across reconnects, with Stop gated
    /// again by the new hello's capability.
    #[uniffi(default = None)]
    pub processes: Option<ProcessesView>,
    /// The host's MCP servers (the `mcp` stream) — `None` until it lands.
    #[uniffi(default = None)]
    pub mcp: Option<McpStatus>,
}

/// The part of `HostSettings` (settings.ts) the settings page edits.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HostSettingsState {
    /// Whether the joined server may vouch for new devices (ADR-0022 §6).
    pub accept_account_devices: bool,
    /// The host name comes from PiNomad's settings.json rather than the
    /// machine — `SetHostName { name: None }` has something to reset.
    pub host_name_custom: bool,
    /// Release checks and idle upgrades (ADR-0043 §6); `None` before 5.30.
    #[uniffi(default = None)]
    pub auto_upgrade: Option<AutoUpgradeMode>,
    /// How steer messages queued while the agent works are delivered;
    /// `None` when the host sent a mode this client doesn't know.
    #[uniffi(default = None)]
    pub steering_mode: Option<QueueDelivery>,
    /// The same for follow-up messages.
    #[uniffi(default = None)]
    pub follow_up_mode: Option<QueueDelivery>,
    /// The keys PiNomad's settings set, as opposed to pi's defaults — the
    /// ones a "Use pi's default" can clear.
    #[uniffi(default = [])]
    pub custom: Vec<String>,
}

/// `QueueMode` (settings.ts): queued messages go one per turn, or all at
/// the next boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum QueueDelivery {
    OneAtATime,
    All,
}

impl QueueDelivery {
    fn from_str(text: &str) -> Option<Self> {
        match text {
            "one-at-a-time" => Some(Self::OneAtATime),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OneAtATime => "one-at-a-time",
            Self::All => "all",
        }
    }
}

/// The `mcp` stream (mcp.ts `McpStatus`) without its `configPath`: no page
/// shows where the file lives.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct McpStatus {
    /// Config-level errors: an unreadable file or a malformed server entry.
    pub errors: Vec<String>,
    pub servers: Vec<McpServer>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct McpServer {
    pub name: String,
    pub state: McpServerState,
    pub error: Option<String>,
    pub tools: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum McpServerState {
    Connecting,
    Connected,
    Failed,
    Disabled,
    /// A state this client doesn't know.
    Other,
}

/// One paired device (devices.ts `DeviceEntry`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct DeviceEntry {
    /// Base64url X25519 public key — what `RevokeDevice` takes, and what
    /// `device_public_key` derives for this device.
    pub public_key: String,
    pub name: String,
    /// Epoch milliseconds.
    pub paired_at: f64,
    /// `None` on entries from before sources existed, and for a source
    /// this client doesn't know.
    pub source: Option<DeviceSource>,
}

/// How a device registered (devices.ts `DeviceSource`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum DeviceSource {
    /// A one-time offer the user was shown.
    Qr,
    /// A loopback-only offer for a client on the host's machine.
    Local,
    /// One the joined server vouched for.
    Account,
}

/// The shown conversation, fully derived.
#[derive(Clone, Debug, uniffi::Record)]
pub struct ConversationSnapshot {
    pub id: u64,
    /// `deriveChat`'s entries in turn order — stable ids for the list.
    pub chat: Vec<ChatEntry>,
    /// `statusText` — what the run is doing beyond "busy"; "" when idle.
    pub status_text: String,
    /// `queueItems` — queued steers/follow-ups/writes.
    pub queue_items: Vec<QueueItem>,
    /// `agentOf` — the `pi.agent` doc (model, level, cwd).
    pub agent: AgentState,
    /// `pendingQuestions` — unresolved `pinomad.question` requests.
    pub questions: Vec<PendingQuestion>,
    /// The `pinomad.todo` document's items; `None` while the conversation
    /// has no todo list.
    pub todo: Option<Vec<TodoItem>>,
    /// `homeOf` — inherited from the index ancestor.
    pub home: Option<Home>,
    /// `checkoutOf` — the conversation's (or ancestor's) worktree.
    pub checkout: Option<WorktreeCheckout>,
    /// `isBusy` — a run is in flight.
    pub busy: bool,
    /// `contextUsage` — the composer's context meter; `None` until a
    /// qualifying reply lands after the last compaction/reset.
    pub context_usage: Option<ContextUsage>,
    /// `matchingBreakdown` — what fills that context, while the host's
    /// breakdown belongs to the reply the meter counts (5.31).
    pub context_breakdown: Option<crate::presentation::ContextBreakdown>,
    /// Whether this connection has received the conversation's fresh
    /// snapshot. Goes false on a reconnect hello (the old view stays on
    /// screen) and true when the new snapshot lands, so ref images can wait
    /// to fetch until their subscription is actually live.
    pub fresh: bool,
    /// Monotonic freshness marker; changes whenever the shown conversation
    /// becomes fresh on a (re)connect. The UI retries ref images on a
    /// change, even if snapshot coalescing skipped the false state.
    pub fresh_epoch: u64,
    /// Local sends the host has not replaced with a real bubble yet
    /// (ADR-0034 §5), in send order. The transcript appends them after
    /// `chat`; the newest committed user bubble carries the delivered mark.
    #[uniffi(default)]
    pub local_submissions: Vec<LocalSubmission>,
    /// Local queue-placed sends whose host inbox row has not arrived yet.
    /// The composer shows them after `queue_items`.
    #[uniffi(default)]
    pub local_queue_items: Vec<LocalQueueItem>,
    /// The shown view has a `before` (5.28): older turns exist that
    /// `FfiCall::LoadEarlier` pages in. Always false without
    /// `transcript_paging`, where the whole transcript arrives.
    #[uniffi(default)]
    pub has_earlier: bool,
}

fn connection_of(view: &Json) -> ConnectionState {
    match view.get("connection").and_then(Json::as_str).map(|s| s.units()) {
        Some(u) if *u == b"reconnecting".map(|c| c as u16) => ConnectionState::Reconnecting,
        Some(u) if *u == b"closed".map(|c| c as u16) => ConnectionState::Closed,
        Some(u) if *u == b"outdated".map(|c| c as u16) => ConnectionState::Outdated,
        _ => ConnectionState::Connected,
    }
}

fn notices_of(view: &Json) -> Vec<Notice> {
    view.get("notices")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    let id = crate::json::num_key(entry.get("id"))?;
                    Some(Notice {
                        id,
                        level: entry
                            .get("level")
                            .and_then(Json::as_str)
                            .map(|s| s.to_string_lossy())
                            .unwrap_or_default(),
                        message: entry
                            .get("message")
                            .and_then(Json::as_str)
                            .map(|s| s.to_string_lossy())
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn models_of(view: &Json) -> Vec<ModelSummary> {
    view.get("models")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .map(|entry| ModelSummary::from_core(crate::model::ModelSummary::from_json(entry)))
                .collect()
        })
        .unwrap_or_default()
}

fn defaults_of(view: &Json) -> Defaults {
    let empty = Json::Null;
    let defaults = view.get("defaults").unwrap_or(&empty);
    Defaults {
        model: defaults.get("model").and_then(ModelRef::from_json),
        thinking_level: defaults
            .get("thinkingLevel")
            .and_then(Json::as_str)
            .map(|s| ThinkingLevel::from_units(s.units())),
    }
}

/// The `agents` stream's value, typed — `null` (host < 5.6 or the stream
/// hasn't landed) decodes to `None`, anything else to a lenient record.
fn agents_of(view: &Json) -> Option<AgentRoles> {
    let agents = view.get("agents")?;
    if matches!(agents, Json::Null) {
        return None;
    }
    let text = |entry: &Json, key: &str| -> String {
        entry
            .get(key)
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .unwrap_or_default()
    };
    let roles = agents
        .get("roles")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .map(|entry| AgentRole {
                    name: text(entry, "name"),
                    description: text(entry, "description"),
                    model: entry.get("model").and_then(Json::as_str).map(|s| s.to_string_lossy()),
                    thinking_level: entry
                        .get("thinkingLevel")
                        .and_then(Json::as_str)
                        .map(|s| ThinkingLevel::from_units(s.units())),
                    prompt: text(entry, "prompt"),
                })
                .collect()
        })
        .unwrap_or_default();
    let problems = agents
        .get("problems")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .map(|entry| AgentRoleProblem {
                    file: text(entry, "file"),
                    reason: text(entry, "reason"),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(AgentRoles { roles, problems })
}

fn mismatch_of(view: &Json) -> Option<ProtocolMismatch> {
    let value = view.get("protocolMismatch")?;
    Some(ProtocolMismatch {
        host_major: value.get("hostMajor").and_then(Json::as_number).unwrap_or(f64::NAN),
        client_major: value.get("clientMajor").and_then(Json::as_number).unwrap_or(f64::NAN),
        host_version: value
            .get("hostVersion")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy()),
        direction: value
            .get("direction")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .unwrap_or_default(),
    })
}

fn host_name_of(view: &Json) -> Option<String> {
    view.get("settings")
        .and_then(|settings| settings.get("hostName"))
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
}

fn settings_of(view: &Json) -> Option<HostSettingsState> {
    let settings = view.get("settings").filter(|s| !matches!(s, Json::Null))?;
    let custom: Vec<String> = settings
        .get("custom")
        .and_then(Json::as_array)
        .map(|keys| keys.iter().filter_map(|k| k.as_str().map(|s| s.to_string_lossy())).collect())
        .unwrap_or_default();
    let mode = |key: &str| {
        settings
            .get(key)
            .and_then(Json::as_str)
            .and_then(|s| QueueDelivery::from_str(&s.to_string_lossy()))
    };
    Some(HostSettingsState {
        // Defaults on (settings.ts); a host older than the switch omits it.
        accept_account_devices: !matches!(settings.get("acceptAccountDevices"), Some(Json::Bool(false))),
        host_name_custom: custom.iter().any(|key| key == "hostName"),
        auto_upgrade: auto_upgrade_of(settings),
        steering_mode: mode("steeringMode"),
        follow_up_mode: mode("followUpMode"),
        custom,
    })
}

fn mcp_of(view: &Json) -> Option<McpStatus> {
    let mcp = view.get("mcp").filter(|m| !matches!(m, Json::Null))?;
    let text = |entry: &Json, key: &str| entry.get(key).and_then(Json::as_str).map(|s| s.to_string_lossy());
    let list = |key: &str| mcp.get(key).and_then(Json::as_array).cloned().unwrap_or_default();
    Some(McpStatus {
        errors: list("errors").iter().filter_map(|e| e.as_str().map(|s| s.to_string_lossy())).collect(),
        servers: list("servers")
            .iter()
            .map(|entry| McpServer {
                name: text(entry, "name").unwrap_or_default(),
                state: match text(entry, "state").as_deref() {
                    Some("connecting") => McpServerState::Connecting,
                    Some("connected") => McpServerState::Connected,
                    Some("failed") => McpServerState::Failed,
                    Some("disabled") => McpServerState::Disabled,
                    _ => McpServerState::Other,
                },
                error: text(entry, "error"),
                tools: entry.get("tools").and_then(Json::as_number).filter(|n| *n >= 0.0).map(|n| n as u32).unwrap_or(0),
            })
            .collect(),
    })
}

fn devices_of(view: &Json) -> Vec<DeviceEntry> {
    let text = |entry: &Json, key: &str| entry.get(key).and_then(Json::as_str).map(|s| s.to_string_lossy());
    view.get("devices")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    Some(DeviceEntry {
                        public_key: text(entry, "publicKey")?,
                        name: text(entry, "name").unwrap_or_default(),
                        paired_at: entry.get("pairedAt").and_then(Json::as_number).unwrap_or(f64::NAN),
                        source: match text(entry, "source").as_deref() {
                            Some("qr") => Some(DeviceSource::Qr),
                            Some("local") => Some(DeviceSource::Local),
                            Some("account") => Some(DeviceSource::Account),
                            _ => None,
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn host_of(view: &Json) -> Option<HostInfo> {
    let host = view.get("host")?;
    let protocol = host.get("protocol")?;
    Some(HostInfo {
        version: host.get("version").and_then(Json::as_str).map(|s| s.to_string_lossy()),
        protocol: ProtocolVersion {
            major: crate::json::num_key(protocol.get("major")).map(|v| v as u32).unwrap_or(0),
            minor: crate::json::num_key(protocol.get("minor")).map(|v| v as u32).unwrap_or(0),
        },
    })
}

fn conversation_of(view: &Json, fresh: bool, fresh_epoch: u64) -> Option<ConversationSnapshot> {
    let conversation = view.get("conversation")?;
    let id = crate::json::num_key(
        conversation
            .get("conversation")
            .and_then(|c| c.get("id")),
    )?;
    let busy = is_busy(conversation);
    // The local-send derivations take the reference's merged ConversationView
    // (conversation record + docs); the durable view keeps docs one level up.
    let local_scope = {
        let mut object = JsonObject::new();
        if let Some(record) = conversation.get("conversation") {
            object.set(U16String::from_str("conversation"), record.clone());
        }
        if let Some(entries) = conversation.get("entries") {
            object.set(U16String::from_str("entries"), entries.clone());
        }
        // The durable view lists documents as `{kind, value}` entries; the
        // core derivations read them by kind (the inbox, for queue rows).
        if let Some(items) = view.get("docs").and_then(Json::as_array) {
            let mut docs = JsonObject::new();
            for item in items.iter() {
                let Some(kind) = item.get("kind").and_then(Json::as_str) else { continue };
                if let Some(value) = item.get("value") {
                    docs.set(kind.clone(), value.clone());
                }
            }
            object.set(U16String::from_str("docs"), Json::Object(std::sync::Arc::new(docs)));
        }
        if let Some(submissions) = view.get("submissions") {
            object.set(U16String::from_str("submissions"), submissions.clone());
        }
        Json::Object(std::sync::Arc::new(object))
    };
    let empty_presentations = Json::object();
    let tool_presentations = view.get("toolPresentations").unwrap_or(&empty_presentations);
    let chat = crate::cot_view::derive_chat(conversation, tool_presentations, busy);
    let agent = agent_of(conversation);
    let docs: Vec<Json> = view
        .get("docs")
        .and_then(Json::as_array)
        .map(|list| list.as_ref().clone())
        .unwrap_or_default();
    let questions = pending_questions(&docs)
        .into_iter()
        .map(|pending| PendingQuestion {
            kind: pending.kind,
            request: QuestionRequest {
                id: pending.request.id,
                questions: pending.request.questions,
                asked_at: pending.request.asked_at,
                resolution: pending.request.resolution,
            },
        })
        .collect();
    let todo = docs.iter().find_map(|doc| {
        let value = doc.get("value").cloned().unwrap_or(Json::Null);
        match crate::presentation::classify(doc.get("presentation"), &value) {
            crate::presentation::ClassifiedDoc::Todo(todo) => Some(todo.items),
            _ => None,
        }
    });
    // The shown model's window scales the meter; an unlisted model leaves it
    // scaleless like the reference's `summaryOf` miss.
    let context_window = view
        .get("models")
        .and_then(Json::as_array)
        .and_then(|models| crate::model::summary_of(models, agent.model.clone()))
        .and_then(|summary| summary.context_window);
    let context_usage = crate::context_usage::context_usage(conversation, context_window);
    let context_breakdown = crate::context_usage::matching_breakdown(&docs, context_usage);
    Some(ConversationSnapshot {
        id,
        chat,
        status_text: status_text(conversation),
        queue_items: queue_items(conversation),
        agent: AgentState {
            model: agent.model,
            thinking_level: agent.thinking_level,
            instructions: agent.instructions,
            cwd: agent.cwd,
        },
        questions,
        todo,
        home: view.get("home").map(Home::from_json),
        checkout: view.get("checkout").map(WorktreeCheckout::from_json),
        busy,
        context_usage,
        context_breakdown,
        fresh,
        fresh_epoch,
        local_submissions: local_submissions_of(&local_scope),
        local_queue_items: local_queue_items_of(&local_scope),
        has_earlier: conversation.get("before").is_some(),
    })
}

/// `None` until `ReadyOutcome::Connected` — before the first view there is
/// no state to deliver.
pub(crate) fn build(remote: &RemoteDurable) -> Option<ClientSnapshot> {
    let view = remote.view()?;
    let empty = Json::Null;
    let organized = Organized::from_json(view.get("organized").unwrap_or(&empty));
    let fresh = remote.conversation_is_fresh();
    let fresh_epoch = remote.conversation_fresh_epoch();
    Some(ClientSnapshot {
        version: remote.version(),
        connection: connection_of(&view),
        unauthorized: matches!(view.get("unauthorized"), Some(Json::Bool(true))),
        protocol_mismatch: mismatch_of(&view),
        host: host_of(&view),
        host_name: host_name_of(&view),
        settings: settings_of(&view),
        devices: devices_of(&view),
        organized,
        notices: notices_of(&view),
        models: models_of(&view),
        defaults: defaults_of(&view),
        agents: agents_of(&view),
        conversation: conversation_of(&view, fresh, fresh_epoch),
        providers: providers_of(&view),
        upgrade: upgrade_of(&view),
        processes: remote.processes_view(),
        mcp: mcp_of(&view),
    })
}
