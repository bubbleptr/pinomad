// `PinomadClient::snapshot` — the whole UI state at one version, decoded
// out of the Json view in a single pass. The core derivations still run on
// the Json the stream carries; this file just shapes the delivery.

use crate::chat::{agent_of, queue_items, status_text};
use crate::cot_view::ChatEntry;
use crate::ffi::types::*;
use crate::json::Json;
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
    /// `homeOf` — inherited from the index ancestor.
    pub home: Option<Home>,
    /// `checkoutOf` — the conversation's (or ancestor's) worktree.
    pub checkout: Option<WorktreeCheckout>,
    /// `isBusy` — a run is in flight.
    pub busy: bool,
    /// `contextUsage` — the composer's context meter; `None` until a
    /// qualifying reply lands after the last compaction/reset.
    pub context_usage: Option<ContextUsage>,
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

fn conversation_of(view: &Json) -> Option<ConversationSnapshot> {
    let conversation = view.get("conversation")?;
    let id = crate::json::num_key(
        conversation
            .get("conversation")
            .and_then(|c| c.get("id")),
    )?;
    let busy = is_busy(conversation);
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
    // The shown model's window scales the meter; an unlisted model leaves it
    // scaleless like the reference's `summaryOf` miss.
    let context_window = view
        .get("models")
        .and_then(Json::as_array)
        .and_then(|models| crate::model::summary_of(models, agent.model.clone()))
        .and_then(|summary| summary.context_window);
    let context_usage = crate::context_usage::context_usage(conversation, context_window);
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
        home: view.get("home").map(Home::from_json),
        checkout: view.get("checkout").map(WorktreeCheckout::from_json),
        busy,
        context_usage,
    })
}

/// `None` until `ReadyOutcome::Connected` — before the first view there is
/// no state to deliver.
pub(crate) fn build(remote: &RemoteDurable) -> Option<ClientSnapshot> {
    let view = remote.view()?;
    let empty = Json::Null;
    let organized = Organized::from_json(view.get("organized").unwrap_or(&empty));
    Some(ClientSnapshot {
        version: remote.version(),
        connection: connection_of(&view),
        unauthorized: matches!(view.get("unauthorized"), Some(Json::Bool(true))),
        protocol_mismatch: mismatch_of(&view),
        host: host_of(&view),
        organized,
        notices: notices_of(&view),
        models: models_of(&view),
        defaults: defaults_of(&view),
        agents: agents_of(&view),
        conversation: conversation_of(&view),
    })
}
