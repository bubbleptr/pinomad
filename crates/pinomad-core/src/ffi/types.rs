// The FFI types: events in, commands out, and the delivery copies of the
// core's derived records. Records the core keeps a private `raw: Json` on
// get a Json-free twin here — the FFI boundary carries only owned fields.
//
// Pure-field records and enums derive UniFFI in place in the core modules
// and are re-exported; this file holds the twins plus conversions.

use crate::ffi::calls::FfiCall;
use crate::json::{Json, JsonObject};
use crate::remote_durable::ReadyOutcome as CoreReadyOutcome;
use crate::u16str::U16String;
use std::sync::Arc;

pub use crate::chat::{QueueItem, QueueMode, TaskRow, UsageRow};
pub use crate::cot_view::{
    ChatEntry, CotAnswer, CotPhase, CotStep, CotView, LiftedSubagent, RetryRequest, SplitSubagents,
};
pub use crate::folder_path::FolderCrumb;
pub use crate::frames::{ApnsEnvironment, ApnsPushToken, HostFeature, ProtocolVersion};
pub use crate::model::{AgentDraft, AgentDraftProblem, AgentDraftSource, ModelPick, ModelRef, ThinkingLevel};
pub use crate::organization::{
    ConversationStatus, HomeKind, SummaryActivity, SummaryKind,
};
pub use crate::patch::{PatchFile, PatchLine, PatchLineKind};
pub use crate::presentation::{
    CodemodeCallStatus, DocType, QuestionAnswer, QuestionItem, QuestionOption, QuestionResolution,
    TodoItem, TodoStatus,
};
pub use crate::stored_host::HostLabel;
pub use crate::tool_item::{
    DiffStat, MessageImage, PinomadToolDetail, ToolItem, ToolKind, ToolPartState,
};

fn lossy(value: Option<&Json>) -> Option<String> {
    value.and_then(Json::as_str).map(|s| s.to_string_lossy())
}


fn set(obj: &mut JsonObject, name: &str, value: Json) {
    obj.set(U16String::from_str(name), value);
}

// ─── Events in ──────────────────────────────────────────────────────────────

/// Everything the platform feeds in, one variant per core `Event`. `Invoke`
/// carries the caller-chosen op id and the typed call.
#[derive(Debug, uniffi::Enum)]
pub enum FfiEvent {
    SocketOpened { conn: u64 },
    SocketData { conn: u64, bytes: Vec<u8> },
    SocketClosed { conn: u64, code: u16, reason: Option<String> },
    SendFailed { conn: u64 },
    TimerFired { timer: u64 },
    Invoke { op: u64, call: FfiCall },
    Close,
    Foreground,
    Background,
    NetworkChanged,
}

// ─── Commands out ───────────────────────────────────────────────────────────

/// Everything the platform executes, mirroring the core `Command` enum —
/// the only difference is the typed `CallResult` on `OperationSucceeded`.
#[derive(Debug, uniffi::Enum)]
pub enum FfiCommand {
    OpenConnection { conn: u64, url: String },
    SendBytes { conn: u64, bytes: Vec<u8> },
    CloseSocket { conn: u64 },
    ScheduleReconnect { timer: u64, delay_ms: u64 },
    CancelReconnect { timer: u64 },
    Ready { outcome: ReadyOutcome },
    /// The view changed; call `snapshot()` after coalescing. This is the
    /// only command the platform may merge-drop.
    ViewChanged,
    /// First pairing completed: persist `url`/`host_key`/`private_key`
    /// (the `StoredHost` the keychain keeps).
    Paired { url: String, host_key: String, private_key: String },
    OperationSucceeded { op: u64, value: CallResult },
    /// Request-class calls only — commands and abort report their failure
    /// as a view notice and still succeed.
    OperationFailed { op: u64, error: String },
}

/// What the client reports when the first view arrives — or why it never
/// will, mirroring the ready promise's rejections.
#[derive(Debug, PartialEq, uniffi::Enum)]
pub enum ReadyOutcome {
    Connected,
    /// Socket closed with 4401 before the first view.
    Unauthorized,
    /// The host speaks a protocol major we do not.
    Mismatch {
        host_major: f64,
        client_major: f64,
        direction: String,
        host_version: Option<String>,
    },
    Error { message: String },
}

impl From<CoreReadyOutcome> for ReadyOutcome {
    fn from(outcome: CoreReadyOutcome) -> Self {
        match outcome {
            CoreReadyOutcome::Connected => ReadyOutcome::Connected,
            CoreReadyOutcome::Unauthorized => ReadyOutcome::Unauthorized,
            CoreReadyOutcome::Mismatch {
                host_major,
                client_major,
                direction,
                host_version,
            } => ReadyOutcome::Mismatch {
                host_major,
                client_major,
                direction,
                host_version,
            },
            CoreReadyOutcome::Error(message) => ReadyOutcome::Error { message },
        }
    }
}

/// The typed value an `OperationSucceeded` carries. Only Request-class
/// calls with a meaningful result get a variant — everything else is
/// `Unit` (and `createConversation` is a Command: read the new conversation
/// from the next snapshot).
#[derive(Debug, PartialEq, uniffi::Enum)]
pub enum CallResult {
    Unit,
    /// `addProject` — the normalized project record the host stored.
    Project { project: Project },
    /// `listFolders` — one page of the folder picker.
    FolderListing { listing: FolderListing },
    /// `changes` — the conversation's file changes, already parsed into
    /// per-file records. Swift never sees the raw unified diff.
    Changes { changes: ConversationChanges },
    /// `listFiles` — `/`-separated paths relative to the scope's root;
    /// `truncated` marks any enumeration or result cap the answer hit.
    Files { files: Vec<String>, truncated: bool },
    /// `createPairing` — the one-time offer another device scans; `url`
    /// carries the host key and secret, `expires_at` is epoch ms.
    Pairing { url: String, expires_at: f64 },
}

/// `createPairing`'s typed result — strict like `changes_of`: the offer is
/// only safe to display whole, so a malformed shape fails the op.
pub(crate) fn pairing_of(value: Option<&Json>) -> Result<(String, f64), String> {
    let value = value
        .filter(|v| v.is_object())
        .ok_or_else(|| "malformed createPairing result".to_string())?;
    let url = value
        .get("url")
        .and_then(Json::as_str)
        .map(|s| s.to_string_lossy())
        .ok_or_else(|| "malformed createPairing result: url".to_string())?;
    let expires_at = value
        .get("expiresAt")
        .and_then(Json::as_number)
        .ok_or_else(|| "malformed createPairing result: expiresAt".to_string())?;
    Ok((url, expires_at))
}

/// `listFiles`'s typed result — strict like `changes_of`: a malformed shape
/// is a host-contract violation and fails the op.
pub(crate) fn files_of(value: Option<&Json>) -> Result<(Vec<String>, bool), String> {
    let value = value
        .filter(|v| v.is_object())
        .ok_or_else(|| "malformed listFiles result".to_string())?;
    let files = value
        .get("files")
        .and_then(Json::as_array)
        .ok_or_else(|| "malformed listFiles result: files".to_string())?
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(|s| s.to_string_lossy())
                .ok_or_else(|| "malformed listFiles result: files".to_string())
        })
        .collect::<Result<Vec<String>, String>>()?;
    let truncated = match value.get("truncated") {
        Some(Json::Bool(truncated)) => *truncated,
        _ => return Err("malformed listFiles result: truncated".to_string()),
    };
    Ok((files, truncated))
}

/// The `changes` call's payload, mirroring the wire union
/// `{available:false, reason}` | `{available:true, base, patch, truncated}`
/// — the `patch` string is parsed into `files` at the facade.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum ConversationChanges {
    /// Chat checkouts and non-git directories have no diff — `reason` is
    /// the host's.
    Unavailable { reason: String },
    /// `truncated` marks a host-side 1 MiB cut at a line boundary.
    Available { base: String, files: Vec<PatchFile>, truncated: bool },
}

/// `changes`'s typed result — strict decode: a malformed shape is a
/// host-contract violation, so the op reports `OperationFailed` rather than
/// guessing at a value (unlike the lenient stream-state decodes).
pub(crate) fn changes_of(value: Option<&Json>) -> Result<ConversationChanges, String> {
    let value = value
        .filter(|v| v.is_object())
        .ok_or_else(|| "malformed changes result".to_string())?;
    let string = |name: &str| -> Result<String, String> {
        value
            .get(name)
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy())
            .ok_or_else(|| format!("malformed changes result: {name}"))
    };
    match value.get("available") {
        Some(Json::Bool(true)) => Ok(ConversationChanges::Available {
            base: string("base")?,
            files: crate::patch::parse_patch(&string("patch")?),
            truncated: match value.get("truncated") {
                Some(Json::Bool(truncated)) => *truncated,
                _ => return Err("malformed changes result: truncated".to_string()),
            },
        }),
        Some(Json::Bool(false)) => Ok(ConversationChanges::Unavailable {
            reason: string("reason")?,
        }),
        _ => Err("malformed changes result: available".to_string()),
    }
}

// ─── Delivery records ───────────────────────────────────────────────────────

/// The `ConversationSummary` the UI reads — every field the core decodes,
/// without the raw document.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ConversationSummary {
    /// Absent when the wire id is missing or not a non-negative integer.
    pub id: Option<u64>,
    pub kind: Option<SummaryKind>,
    pub parent: Option<u64>,
    pub forked_at: Option<String>,
    pub title: Option<String>,
    /// Absent means idle. Precedence: needs-answer > running > failed.
    pub status: Option<ConversationStatus>,
    /// Epoch ms of the conversation's newest own message.
    pub updated_at: Option<f64>,
    pub label: Option<String>,
    pub role: Option<String>,
    pub activity: Option<SummaryActivity>,
}

impl ConversationSummary {
    pub fn from_core(core: crate::organization::ConversationSummary) -> Self {
        ConversationSummary {
            id: core.id,
            kind: core.kind,
            parent: core.parent,
            forked_at: core.forked_at,
            title: core.title,
            status: core.status,
            updated_at: core.updated_at,
            label: core.label,
            role: core.role,
            activity: core.activity,
        }
    }

    /// Reconstructed wire object for the stateless derivations — every
    /// field they read is present when decoded (a field absent on the wire
    /// stays absent here).
    pub(crate) fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        if let Some(id) = self.id {
            set(&mut object, "id", Json::Number(id as f64));
        }
        if let Some(kind) = &self.kind {
            set(&mut object, "kind", Json::from(kind.as_str()));
        }
        if let Some(parent) = self.parent {
            set(&mut object, "parent", Json::Number(parent as f64));
        }
        if let Some(forked_at) = &self.forked_at {
            set(&mut object, "forkedAt", Json::from(forked_at.clone()));
        }
        if let Some(title) = &self.title {
            set(&mut object, "title", Json::from(title.clone()));
        }
        if let Some(status) = &self.status {
            set(&mut object, "status", Json::from(status.as_str()));
        }
        if let Some(updated_at) = self.updated_at {
            set(&mut object, "updatedAt", Json::Number(updated_at));
        }
        if let Some(label) = &self.label {
            set(&mut object, "label", Json::from(label.clone()));
        }
        if let Some(role) = &self.role {
            set(&mut object, "role", Json::from(role.clone()));
        }
        if let Some(activity) = &self.activity {
            let mut entry = JsonObject::new();
            set(&mut entry, "tool", Json::from(activity.tool.clone()));
            if let Some(target) = &activity.target {
                set(&mut entry, "target", Json::from(target.clone()));
            }
            set(&mut object, "activity", Json::Object(Arc::new(entry)));
        }
        Json::Object(Arc::new(object))
    }
}

/// A node in the organized tree — forks and subagents nest under their
/// owner's children.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ConversationNode {
    pub summary: ConversationSummary,
    pub children: Vec<ConversationNode>,
}

impl ConversationNode {
    pub(crate) fn from_core(core: crate::organization::ConversationNode) -> Self {
        ConversationNode {
            summary: ConversationSummary::from_core(core.summary),
            children: core.children.into_iter().map(Self::from_core).collect(),
        }
    }

    /// Decode one `{summary, children}` node of `view.organized` — the
    /// summary's raw Json is right there, so decode through the core.
    pub(crate) fn from_json(value: &Json) -> Self {
        let empty = Json::Null;
        let raw = value.get("summary").unwrap_or(&empty);
        ConversationNode {
            summary: ConversationSummary::from_core(crate::organization::ConversationSummary::new(
                raw.clone(),
            )),
            children: value
                .get("children")
                .and_then(Json::as_array)
                .map(|list| list.iter().map(Self::from_json).collect())
                .unwrap_or_default(),
        }
    }

    pub(crate) fn to_core(&self) -> crate::organization::ConversationNode {
        crate::organization::ConversationNode {
            summary: crate::organization::ConversationSummary::new(self.summary.to_json()),
            children: self.children.iter().map(Self::to_core).collect(),
        }
    }
}

/// A registered project directory, without its raw document.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Project {
    pub path: Option<String>,
    pub name: Option<String>,
    /// Epoch ms the project was added — the list sorts newest first.
    pub added_at: Option<f64>,
}

impl Project {
    pub fn from_core(core: crate::organization::Project) -> Self {
        Project {
            path: core.path,
            name: core.name,
            added_at: core.added_at,
        }
    }
}

/// `addProject`'s typed result: decode leniently — a malformed host value
/// degrades to empty fields rather than a transport error.
pub(crate) fn project_of(value: Option<&Json>) -> Project {
    Project {
        path: value.and_then(|v| lossy(v.get("path"))),
        name: value.and_then(|v| lossy(v.get("name"))),
        added_at: value.and_then(|v| v.get("addedAt")).and_then(Json::as_number),
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ProjectConversations {
    pub project: Project,
    pub conversations: Vec<ConversationNode>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct ArchivedConversation {
    pub node: ConversationNode,
    /// Absent for an archived Chat.
    pub project: Option<Project>,
}

/// `view.organized`, typed.
#[derive(Clone, Debug, uniffi::Record)]
pub struct Organized {
    pub chats: Vec<ConversationNode>,
    pub projects: Vec<ProjectConversations>,
    /// Archived roots, newest first.
    pub archived: Vec<ArchivedConversation>,
}

impl Organized {
    pub(crate) fn from_json(value: &Json) -> Self {
        let nodes = |key: &str| -> Vec<ConversationNode> {
            value
                .get(key)
                .and_then(Json::as_array)
                .map(|list| list.iter().map(ConversationNode::from_json).collect())
                .unwrap_or_default()
        };
        let projects = value
            .get("projects")
            .and_then(Json::as_array)
            .map(|list| {
                list.iter()
                    .map(|entry| {
                        let empty = Json::Null;
                        let raw = entry.get("project").unwrap_or(&empty);
                        ProjectConversations {
                            project: Project::from_core(crate::organization::Project::new(raw.clone())),
                            conversations: entry
                                .get("conversations")
                                .and_then(Json::as_array)
                                .map(|list| list.iter().map(ConversationNode::from_json).collect())
                                .unwrap_or_default(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let archived = value
            .get("archived")
            .and_then(Json::as_array)
            .map(|list| {
                list.iter()
                    .map(|entry| {
                        let empty = Json::Null;
                        ArchivedConversation {
                            node: entry
                                .get("node")
                                .map(ConversationNode::from_json)
                                .unwrap_or_else(|| ConversationNode::from_json(&empty)),
                            project: entry
                                .get("project")
                                .map(|p| Project::from_core(crate::organization::Project::new(p.clone()))),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Organized {
            chats: nodes("chats"),
            projects,
            archived,
        }
    }

    /// Back to the core tree for the family derivations — summaries rebuild
    /// their raw from the decoded fields.
    pub(crate) fn to_core(&self) -> crate::organization::Organized {
        crate::organization::Organized {
            chats: self.chats.iter().map(ConversationNode::to_core).collect(),
            projects: self
                .projects
                .iter()
                .map(|p| crate::organization::ProjectConversations {
                    project: crate::organization::Project::new(project_json(&p.project)),
                    conversations: p.conversations.iter().map(ConversationNode::to_core).collect(),
                })
                .collect(),
            archived: self
                .archived
                .iter()
                .map(|a| crate::organization::ArchivedConversation {
                    node: a.node.to_core(),
                    project: a
                        .project
                        .as_ref()
                        .map(|p| crate::organization::Project::new(project_json(p))),
                })
                .collect(),
        }
    }
}

fn project_json(project: &Project) -> Json {
    let mut object = JsonObject::new();
    if let Some(path) = &project.path {
        set(&mut object, "path", Json::from(path.clone()));
    }
    if let Some(name) = &project.name {
        set(&mut object, "name", Json::from(name.clone()));
    }
    if let Some(added_at) = project.added_at {
        set(&mut object, "addedAt", Json::Number(added_at));
    }
    Json::Object(Arc::new(object))
}

/// Where a top-level conversation lives — a project or a project-less
/// Chat. `Other` keeps a kind a newer host invented.
#[derive(Clone, Debug, uniffi::Enum)]
pub enum Home {
    Project { path: String },
    Chat,
    Other { kind: String, path: Option<String> },
}

impl Home {
    pub(crate) fn from_json(value: &Json) -> Self {
        let home = crate::organization::Home::new(value.clone());
        match home.kind {
            HomeKind::Project => Home::Project {
                path: home.path.unwrap_or_default(),
            },
            HomeKind::Chat => Home::Chat,
            HomeKind::Other(kind) => Home::Other {
                kind,
                path: home.path,
            },
        }
    }
}

/// A per-conversation git worktree record (ADR-0010), without raw.
#[derive(Clone, Debug, uniffi::Record)]
pub struct WorktreeCheckout {
    pub conversation_id: Option<u64>,
    pub path: Option<String>,
    /// The project's repository top level.
    pub repo: Option<String>,
    /// Project path relative to `repo` ("" when the project is the root).
    pub subdir: Option<String>,
    pub branch: Option<String>,
    /// Full commit sha the branch starts at.
    pub base: Option<String>,
    /// Forks only: commit capturing the parent checkout's working tree.
    pub snapshot: Option<String>,
}

impl WorktreeCheckout {
    pub(crate) fn from_json(value: &Json) -> Self {
        let checkout = crate::organization::WorktreeCheckout::new(value.clone());
        WorktreeCheckout {
            conversation_id: checkout.conversation_id,
            path: checkout.path,
            repo: checkout.repo,
            subdir: checkout.subdir,
            branch: checkout.branch,
            base: checkout.base,
            snapshot: checkout.snapshot,
        }
    }
}

/// A host-advertised model with the display metadata — including the
/// `thinkingLevels` list the raw holds and the decoded fields omit.
#[derive(Clone, Debug, uniffi::Record)]
pub struct ModelSummary {
    pub provider: String,
    pub model_id: String,
    pub name: Option<String>,
    pub context_window: Option<f64>,
    /// Levels the model supports, always starting with "off".
    pub thinking_levels: Vec<ThinkingLevel>,
    /// Whether the model accepts image input; absent from pre-5.5 hosts.
    pub images: Option<bool>,
}

impl ModelSummary {
    pub fn from_core(core: crate::model::ModelSummary) -> Self {
        ModelSummary {
            thinking_levels: core.thinking_levels(),
            provider: core.provider,
            model_id: core.model_id,
            name: core.name,
            context_window: core.context_window,
            images: core.supports_images,
        }
    }

    /// Reconstructed wire entry — the model derivations only read these
    /// fields (provider/modelId/name/thinkingLevels; images rides along).
    pub(crate) fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        set(&mut object, "provider", Json::from(self.provider.clone()));
        set(&mut object, "modelId", Json::from(self.model_id.clone()));
        if let Some(name) = &self.name {
            set(&mut object, "name", Json::from(name.clone()));
        }
        if let Some(window) = self.context_window {
            set(&mut object, "contextWindow", Json::Number(window));
        }
        set(
            &mut object,
            "thinkingLevels",
            Json::array(self.thinking_levels.iter().map(|l| Json::from(l.as_str())).collect()),
        );
        if let Some(images) = self.images {
            set(&mut object, "images", Json::Bool(images));
        }
        Json::Object(Arc::new(object))
    }
}

/// The conversation's agent doc (`pi.agent`), decoded.
#[derive(Clone, Debug, uniffi::Record)]
pub struct AgentState {
    pub model: Option<ModelRef>,
    pub thinking_level: Option<ThinkingLevel>,
    pub instructions: Option<String>,
    pub cwd: Option<String>,
}

/// The host's new-conversation defaults — `settings` stream once it has
/// arrived, the hello's otherwise.
#[derive(Clone, Debug, uniffi::Record)]
pub struct Defaults {
    pub model: Option<ModelRef>,
    pub thinking_level: Option<ThinkingLevel>,
}

/// The user's per-side overrides on a picked named agent — the second operand
/// of `resolveAgentDraft` (`{model?, level?}` on the wire).
#[derive(Clone, Debug, uniffi::Record)]
pub struct AgentDraftOverride {
    pub model: Option<ModelRef>,
    pub level: Option<ThinkingLevel>,
}

/// One named agent (ADR-0023) — an `<name>.md` on the host.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentRole {
    /// The file name without `.md`; what `subagent`'s `role` arg takes.
    pub name: String,
    pub description: String,
    /// `provider/modelId`, pinned when set.
    pub model: Option<String>,
    pub thinking_level: Option<ThinkingLevel>,
    /// The Markdown body, trimmed; may be "".
    pub prompt: String,
}

/// A file under the host's agents dir that failed to load.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentRoleProblem {
    /// The file's basename, e.g. `Reviewer.md`.
    pub file: String,
    pub reason: String,
}

/// The `agents` stream's value (`AgentRoles` on the wire): the loadable
/// roles plus the files that didn't parse.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentRoles {
    pub roles: Vec<AgentRole>,
    pub problems: Vec<AgentRoleProblem>,
}

/// One `listFolders` page — the project picker's folder list.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FolderListing {
    /// Absolute, symlink-free path of the listed folder.
    pub path: String,
    /// The host user's home directory — the picker's starting point.
    pub home: String,
    /// Subfolders whose names don't start with ".", sorted by name.
    pub folders: Vec<FolderEntry>,
}

/// `listFolders`'s typed result — same lenient decode as `project_of`.
pub(crate) fn folder_listing_of(value: Option<&Json>) -> FolderListing {
    FolderListing {
        path: value.and_then(|v| lossy(v.get("path"))).unwrap_or_default(),
        home: value.and_then(|v| lossy(v.get("home"))).unwrap_or_default(),
        folders: value
            .and_then(|v| v.get("folders"))
            .and_then(Json::as_array)
            .map(|list| {
                list.iter()
                    .map(|entry| FolderEntry {
                        name: lossy(entry.get("name")).unwrap_or_default(),
                        path: lossy(entry.get("path")).unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// A view notice — command failures and host notices land here; `id` is
/// stable and increasing so the UI can dedupe.
#[derive(Clone, Debug, uniffi::Record)]
pub struct Notice {
    pub id: u64,
    /// `info` | `warning` | `error`, as the host/core emitted it.
    pub level: String,
    pub message: String,
}

/// The version split behind an `outdated` connection.
#[derive(Clone, Debug, uniffi::Record)]
pub struct ProtocolMismatch {
    pub host_major: f64,
    pub client_major: f64,
    /// Packaged release version; absent on a source checkout.
    pub host_version: Option<String>,
    /// `client-older` → update the app; `host-older` → upgrade the host.
    pub direction: String,
}

/// What the host announced in its hello.
#[derive(Clone, Debug, uniffi::Record)]
pub struct HostInfo {
    /// Absent when the host runs from a source checkout.
    pub version: Option<String>,
    pub protocol: ProtocolVersion,
}

/// `view.connection`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ConnectionState {
    Connected,
    Reconnecting,
    Closed,
    /// The hello announced a different protocol major; terminal.
    Outdated,
}

/// An unresolved `pinomad.question` request (ADR-0011) and the kind of the
/// doc carrying it.
#[derive(Clone, Debug, uniffi::Record)]
pub struct PendingQuestion {
    pub kind: String,
    pub request: QuestionRequest,
}

/// `QuestionRequest` without raw — the question card renders from this.
#[derive(Clone, Debug, uniffi::Record)]
pub struct QuestionRequest {
    pub id: String,
    pub questions: Vec<QuestionItem>,
    /// Epoch ms the request was asked.
    pub asked_at: f64,
    /// Absent while the request is still open.
    pub resolution: Option<QuestionResolution>,
}

/// One row of `taskGroupsOf`: the owner summary, its label, its subagents.
#[derive(Clone, Debug, uniffi::Record)]
pub struct TaskGroup {
    pub owner: ConversationSummary,
    pub label: String,
    pub tasks: Vec<ConversationNode>,
}
