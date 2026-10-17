// The project → conversation model from packages/protocol/src/organization.ts.
// organize/findConversation/homeOf/checkoutOf return typed structs now
// (ADR-0024 §6); summaries, projects, and homes keep their raw Json so the
// derived view stays byte-faithful and unknown fields survive.
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::json::{Json, JsonObject};
use crate::u16str::U16String;

fn set(obj: &mut JsonObject, key: &str, value: Json) {
    obj.set(U16String::from_str(key), value);
}

use crate::json::num_key;

fn number(value: Option<&Json>, or: f64) -> f64 {
    value.and_then(Json::as_number).unwrap_or(or)
}

fn str_eq(value: Option<&Json>, want: &str) -> bool {
    value
        .and_then(Json::as_str)
        .is_some_and(|s| s.units() == want.encode_utf16().collect::<Vec<u16>>())
}

fn str_opt(value: Option<&Json>) -> Option<U16String> {
    value.and_then(Json::as_str).cloned()
}

fn text(value: Option<&Json>) -> Option<String> {
    value.and_then(Json::as_str).map(|s| s.to_string_lossy())
}

/// `ConversationSummary.kind` — conversation | fork | subagent; `Other`
/// keeps a kind a newer host invented.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum SummaryKind {
    Conversation,
    Fork,
    Subagent,
    Other(String),
}

impl SummaryKind {
    pub fn as_str(&self) -> &str {
        match self {
            SummaryKind::Conversation => "conversation",
            SummaryKind::Fork => "fork",
            SummaryKind::Subagent => "subagent",
            SummaryKind::Other(value) => value.as_str(),
        }
    }

    fn from_json(value: Option<&Json>) -> Option<Self> {
        value.and_then(Json::as_str).map(|s| match s.units() {
            u if *u == lit("conversation") => SummaryKind::Conversation,
            u if *u == lit("fork") => SummaryKind::Fork,
            u if *u == lit("subagent") => SummaryKind::Subagent,
            other => SummaryKind::Other(U16String(other.to_vec()).to_string_lossy()),
        })
    }
}

/// `ConversationSummary.status` — the family rollup compares these.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ConversationStatus {
    NeedsAnswer,
    Running,
    Failed,
    /// An unknown status string, kept verbatim — a newer host may add states.
    Other(String),
}

impl ConversationStatus {
    pub fn as_str(&self) -> &str {
        match self {
            ConversationStatus::NeedsAnswer => "needs-answer",
            ConversationStatus::Running => "running",
            ConversationStatus::Failed => "failed",
            ConversationStatus::Other(value) => value.as_str(),
        }
    }

    /// Wire equality — the family rollup compares raw status strings, so
    /// unknown values keep identity.
    pub fn matches_wire(&self, value: Option<&Json>) -> bool {
        value.and_then(Json::as_str).is_some_and(|s| s.units() == self.as_str().encode_utf16().collect::<Vec<u16>>())
    }

    fn from_json(value: Option<&Json>) -> Option<Self> {
        value.and_then(Json::as_str).map(|s| match s.units() {
            u if *u == lit("needs-answer") => ConversationStatus::NeedsAnswer,
            u if *u == lit("running") => ConversationStatus::Running,
            u if *u == lit("failed") => ConversationStatus::Failed,
            other => ConversationStatus::Other(U16String(other.to_vec()).to_string_lossy()),
        })
    }
}

/// `ConversationSummary.activity` — the tool call in flight.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct SummaryActivity {
    pub tool: String,
    pub target: Option<String>,
}

/// A conversation summary document: fields decode for the UI; the raw Json
/// stays private so emission round-trips every field, known or not.
#[derive(Clone, Debug)]
pub struct ConversationSummary {
    /// The conversation's numeric id; absent when the raw id is missing or
    /// not a non-negative integer (such a summary never matches lookups).
    pub id: Option<u64>,
    pub kind: Option<SummaryKind>,
    /// Fork source conversation, or the conversation owning the subagent's
    /// task — absent when missing or not a non-negative integer.
    pub parent: Option<u64>,
    /// Forks only: the parent entry the fork inherits through.
    pub forked_at: Option<String>,
    /// The generated or manual name when set, else the first user message;
    /// for a subagent its task.
    pub title: Option<String>,
    /// Absent means idle. Precedence: needs-answer > running > failed.
    pub status: Option<ConversationStatus>,
    /// Epoch ms of the conversation's newest own user/assistant message.
    pub updated_at: Option<f64>,
    /// Subagents only: the `description` the delegating agent gave the call.
    pub label: Option<String>,
    /// Subagents only: the named agent it ran as (ADR-0023).
    pub role: Option<String>,
    /// Running only: the tool call in flight.
    pub activity: Option<SummaryActivity>,
    raw: Json,
}

impl ConversationSummary {
    pub fn new(raw: Json) -> Self {
        Self {
            id: num_key(raw.get("id")),
            kind: SummaryKind::from_json(raw.get("kind")),
            parent: num_key(raw.get("parent")),
            forked_at: text(raw.get("forkedAt")),
            title: text(raw.get("title")),
            status: ConversationStatus::from_json(raw.get("status")),
            updated_at: raw.get("updatedAt").and_then(Json::as_number),
            label: text(raw.get("label")),
            role: text(raw.get("role")),
            activity: raw
                .get("activity")
                .and_then(|a| {
                    a.get("tool").and_then(Json::as_str).map(|tool| SummaryActivity {
                        tool: tool.to_string_lossy(),
                        target: a.get("target").and_then(Json::as_str).map(|t| t.to_string_lossy()),
                    })
                }),
            raw,
        }
    }

    /// The summary verbatim — `ConversationNode` serializes it back whole.
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }

    /// The raw document — derivations that must distinguish "absent" from
    /// "present but malformed" (like a fractional `parent`) read it.
    pub(crate) fn raw(&self) -> &Json {
        &self.raw
    }
}

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[derive(Clone, Debug)]
pub struct ConversationNode {
    pub summary: ConversationSummary,
    pub children: Vec<ConversationNode>,
}

impl ConversationNode {
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        set(&mut object, "summary", self.summary.to_json());
        set(
            &mut object,
            "children",
            Json::array(self.children.iter().map(ConversationNode::to_json).collect()),
        );
        Json::Object(Arc::new(object))
    }
}

/// A registered local directory. The raw Json stays private so emission
/// keeps every field, known or not.
#[derive(Clone, Debug)]
pub struct Project {
    pub path: Option<String>,
    pub name: Option<String>,
    /// Epoch ms the project was added — the project list sorts newest first.
    pub added_at: Option<f64>,
    raw: Json,
}

impl Project {
    pub fn new(raw: Json) -> Self {
        Self {
            path: text(raw.get("path")),
            name: text(raw.get("name")),
            added_at: raw.get("addedAt").and_then(Json::as_number),
            raw,
        }
    }
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

#[derive(Clone, Debug)]
pub struct ProjectConversations {
    pub project: Project,
    pub conversations: Vec<ConversationNode>,
}

#[derive(Clone, Debug)]
pub struct ArchivedConversation {
    pub node: ConversationNode,
    /// Absent for an archived Chat — the TS spread emits no key.
    pub project: Option<Project>,
}

#[derive(Clone, Debug)]
pub struct Organized {
    pub chats: Vec<ConversationNode>,
    pub projects: Vec<ProjectConversations>,
    /// Archived roots, newest first; `project` is absent for a Chat.
    pub archived: Vec<ArchivedConversation>,
}

impl Organized {
    /// The Json shape remote_durable publishes on `view.organized` — the same
    /// `{chats, projects, archived}` the TS organizes into.
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        set(
            &mut object,
            "chats",
            Json::array(self.chats.iter().map(ConversationNode::to_json).collect()),
        );
        set(
            &mut object,
            "projects",
            Json::array(
                self.projects
                    .iter()
                    .map(|p| {
                        let mut item = JsonObject::new();
                        set(&mut item, "project", p.project.to_json());
                        set(
                            &mut item,
                            "conversations",
                            Json::array(p.conversations.iter().map(ConversationNode::to_json).collect()),
                        );
                        Json::Object(Arc::new(item))
                    })
                    .collect(),
            ),
        );
        set(
            &mut object,
            "archived",
            Json::array(
                self.archived
                    .iter()
                    .map(|a| {
                        let mut item = JsonObject::new();
                        set(&mut item, "node", a.node.to_json());
                        if let Some(project) = &a.project {
                            set(&mut item, "project", project.to_json());
                        }
                        Json::Object(Arc::new(item))
                    })
                    .collect(),
            ),
        );
        Json::Object(Arc::new(object))
    }
}

/// Where a top-level conversation lives: inside a project, or a project-less
/// Chat. The raw Json stays private so the home object round-trips.
#[derive(Clone, Debug)]
pub struct Home {
    /// `"project"` | `"chat"` — an unknown kind a newer host invented reads
    /// as `Other`.
    pub kind: HomeKind,
    /// The project directory — project homes only.
    pub path: Option<String>,
    raw: Json,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum HomeKind {
    Project,
    Chat,
    Other(String),
}

impl HomeKind {
    pub fn as_str(&self) -> &str {
        match self {
            HomeKind::Project => "project",
            HomeKind::Chat => "chat",
            HomeKind::Other(value) => value.as_str(),
        }
    }
}

impl Home {
    pub fn new(raw: Json) -> Self {
        let kind = match raw.get("kind").and_then(Json::as_str).map(|s| s.units()) {
            Some(u) if *u == lit("project") => HomeKind::Project,
            Some(u) if *u == lit("chat") => HomeKind::Chat,
            Some(other) => HomeKind::Other(U16String(other.to_vec()).to_string_lossy()),
            None => HomeKind::Other(String::new()),
        };
        Self { kind, path: text(raw.get("path")), raw }
    }
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// A per-conversation git worktree record (ADR-0010).
#[derive(Clone, Debug)]
pub struct WorktreeCheckout {
    /// The conversation this checkout serves — absent when the raw field is
    /// missing or not a non-negative integer.
    pub conversation_id: Option<u64>,
    /// `<dataDir>/worktrees/<conversationId>`.
    pub path: Option<String>,
    /// The project's repository top level (git -C target for worktree commands).
    pub repo: Option<String>,
    /// Project path relative to `repo` ("" when the project is the repo root).
    pub subdir: Option<String>,
    pub branch: Option<String>,
    /// Full commit sha the branch starts at.
    pub base: Option<String>,
    /// Forks only: commit capturing the parent checkout's working tree.
    pub snapshot: Option<String>,
    raw: Json,
}

impl WorktreeCheckout {
    pub fn new(raw: Json) -> Self {
        Self {
            conversation_id: num_key(raw.get("conversationId")),
            path: text(raw.get("path")),
            repo: text(raw.get("repo")),
            subdir: text(raw.get("subdir")),
            branch: text(raw.get("branch")),
            base: text(raw.get("base")),
            snapshot: text(raw.get("snapshot")),
            raw,
        }
    }
    pub fn to_json(&self) -> Json {
        self.raw.clone()
    }
}

/// `organize(index, summaries)`: index entries + summaries →
/// `{chats, projects, archived}` with `{summary, children}` nodes. Missing
/// collections behave like the JS defaults ({projects:[], conversations:[]}).
pub fn organize(index: &Json, summaries: &[Json]) -> Result<Organized, String> {
    let projects = index
        .get("projects")
        .and_then(Json::as_array)
        .ok_or_else(|| "index.projects is not an array".to_string())?;
    let entries = index
        .get("conversations")
        .and_then(Json::as_array)
        .ok_or_else(|| "index.conversations is not an array".to_string())?;

    let summary_by_id: HashMap<u64, &Json> = summaries
        .iter()
        .filter_map(|summary| num_key(summary.get("id")).map(|id| (id, summary)))
        .collect();
    let mut nodes: HashMap<u64, Vec<u64>> = HashMap::new(); // id -> child ids
    let mut summary_of: HashMap<u64, &Json> = HashMap::new();
    let mut top_level: Vec<&Json> = Vec::new();

    for entry in entries.iter() {
        let home = entry.get("home");
        if str_eq(home.and_then(|h| h.get("kind")), "project") {
            let path = str_opt(home.and_then(|h| h.get("path")));
            let exists = projects
                .iter()
                .any(|project| str_opt(project.get("path")) == path);
            if !exists {
                continue;
            }
        }
        let id = match num_key(entry.get("id")) {
            Some(id) if summary_by_id.contains_key(&id) => id,
            _ => continue,
        };
        top_level.push(entry);
        nodes.entry(id).or_default();
        summary_of.insert(id, summary_by_id[&id]);
    }
    let top_ids: HashSet<u64> = top_level
        .iter()
        .filter_map(|entry| num_key(entry.get("id")))
        .collect();

    // A nested summary joins once its ancestor chain reaches a top-level entry.
    for summary in summaries.iter() {
        if num_key(summary.get("id")).is_none() {
            continue;
        }
        let mut chain: Vec<&Json> = vec![summary];
        while !top_ids.contains(&num_key(chain.last().unwrap().get("id")).unwrap_or(u64::MAX)) {
            let parent_id = num_key(chain.last().unwrap().get("parent"));
            let parent = parent_id.and_then(|pid| summary_by_id.get(&pid).copied());
            let Some(parent) = parent else { break };
            if chain.iter().any(|member| std::ptr::eq(*member, parent)) {
                break;
            }
            chain.push(parent);
        }
        if !top_ids.contains(&num_key(chain.last().unwrap().get("id")).unwrap_or(u64::MAX)) {
            continue;
        }
        // Oldest ancestor first: each node attaches under its immediate parent.
        for member in chain.iter().rev() {
            let member_id = match num_key(member.get("id")) {
                Some(id) => id,
                None => continue,
            };
            nodes.entry(member_id).or_default();
            summary_of.insert(member_id, member);
        }
        // Attach: parent is the element AFTER member in the reversed walk —
        // chain is [descendant..ancestor]; reversed is [ancestor..descendant].
        let reversed: Vec<&&Json> = chain.iter().rev().collect();
        for pair in reversed.windows(2) {
            let parent_id = num_key(pair[0].get("id"));
            let child_id = num_key(pair[1].get("id"));
            if let (Some(parent_id), Some(child_id)) = (parent_id, child_id) {
                let children = nodes.entry(parent_id).or_default();
                if !children.contains(&child_id) {
                    children.push(child_id);
                }
            }
        }
    }

    fn node_list(id: u64, nodes: &HashMap<u64, Vec<u64>>, summary_of: &HashMap<u64, &Json>) -> ConversationNode {
        let mut children: Vec<u64> = nodes.get(&id).cloned().unwrap_or_default();
        // `byIdAscending`: children sort by summary.id ascending.
        children.sort();
        ConversationNode {
            summary: summary_of
                .get(&id)
                .map(|raw| ConversationSummary::new((*raw).clone()))
                .unwrap_or_else(|| ConversationSummary::new(Json::Null)),
            children: children
                .into_iter()
                .map(|child| node_list(child, nodes, summary_of))
                .collect(),
        }
    }

    let sort_entries = |list: &mut Vec<&Json>| {
        list.sort_by(|a, b| {
            number(b.get("createdAt"), f64::NAN)
                .partial_cmp(&number(a.get("createdAt"), f64::NAN))
                .unwrap_or(Ordering::Equal)
        });
    };
    let mut sorted: Vec<&Json> = top_level.clone();
    sort_entries(&mut sorted);
    let live: Vec<&&Json> = sorted
        .iter()
        .filter(|entry| entry.get("archived") != Some(&Json::Bool(true)))
        .collect();

    let node_of = |entry: &Json| -> ConversationNode {
        node_list(
            num_key(entry.get("id")).unwrap_or(0),
            &nodes,
            &summary_of,
        )
    };

    let chats = live
        .iter()
        .filter(|entry| str_eq(entry.get("home").and_then(|h| h.get("kind")), "chat"))
        .map(|entry| node_of(entry))
        .collect();

    let mut sorted_projects: Vec<&Json> = projects.iter().collect();
    sorted_projects.sort_by(|a, b| {
        number(b.get("addedAt"), f64::NAN)
            .partial_cmp(&number(a.get("addedAt"), f64::NAN))
            .unwrap_or(Ordering::Equal)
    });
    let projects_out = sorted_projects
        .iter()
        .map(|project| {
            let path = str_opt(project.get("path"));
            ProjectConversations {
                project: Project::new((*project).clone()),
                conversations: live
                    .iter()
                    .filter(|entry| {
                        let home = entry.get("home");
                        str_eq(home.and_then(|h| h.get("kind")), "project")
                            && str_opt(home.and_then(|h| h.get("path"))) == path
                    })
                    .map(|entry| node_of(entry))
                    .collect(),
            }
        })
        .collect();

    let archived = sorted
        .iter()
        .filter(|entry| entry.get("archived") == Some(&Json::Bool(true)))
        .map(|entry| {
            let home = entry.get("home");
            let project = if str_eq(home.and_then(|h| h.get("kind")), "project") {
                let path = str_opt(home.and_then(|h| h.get("path")));
                projects
                    .iter()
                    .find(|project| str_opt(project.get("path")) == path)
                    .map(|p| Project::new(p.clone()))
            } else {
                None
            };
            ArchivedConversation {
                node: node_of(entry),
                project,
            }
        })
        .collect();

    Ok(Organized {
        chats,
        projects: projects_out,
        archived,
    })
}

/// `findConversation`: the organized node for a conversation id, wherever it
/// nests (forks and subagents live under their ancestor). `===` on numbers —
/// a fractional or missing id simply never matches (a caller decodes ids with
/// `num_key` first).
pub fn find_conversation(organized: &Organized, id: u64) -> Option<ConversationNode> {
    fn visit(nodes: &[ConversationNode], id: u64) -> Option<&ConversationNode> {
        for node in nodes {
            if node.summary.id == Some(id) {
                return Some(node);
            }
            if let Some(found) = visit(&node.children, id) {
                return Some(found);
            }
        }
        None
    }
    for node in &organized.chats {
        if let Some(found) = visit(std::slice::from_ref(node), id) {
            return Some(found.clone());
        }
    }
    for entry in &organized.projects {
        if let Some(found) = visit(&entry.conversations, id) {
            return Some(found.clone());
        }
    }
    None
}

/// `homeOf`: the conversation's home — its own entry's, else the nearest
/// index-listed ancestor's.
pub fn home_of(index: &Json, summaries: &[Json], id: u64) -> Option<Home> {
    let entries = index.get("conversations").and_then(Json::as_array)?;
    if let Some(entry) = entries.iter().find(|entry| num_key(entry.get("id")) == Some(id)) {
        return entry.get("home").cloned().map(Home::new);
    }
    let summary_by_id: HashMap<u64, &Json> = summaries
        .iter()
        .filter_map(|summary| num_key(summary.get("id")).map(|sid| (sid, summary)))
        .collect();
    let mut seen = HashSet::new();
    let mut current = summary_by_id.get(&id).copied();
    while let Some(summary) = current {
        let sid = match num_key(summary.get("id")) {
            Some(sid) if seen.insert(sid) => sid,
            _ => break,
        };
        if let Some(entry) = entries.iter().find(|entry| num_key(entry.get("id")) == Some(sid)) {
            return entry.get("home").cloned().map(Home::new);
        }
        current = num_key(summary.get("parent")).and_then(|pid| summary_by_id.get(&pid).copied());
    }
    None
}

/// `checkoutOf`: the conversation's own checkout, else the nearest
/// ancestor's.
pub fn checkout_of(index: &Json, summaries: &[Json], id: u64) -> Option<WorktreeCheckout> {
    let checkouts = index.get("checkouts").and_then(Json::as_array);
    if let Some(record) = checkouts.and_then(|list| {
        list.iter().find(|checkout| num_key(checkout.get("conversationId")) == Some(id))
    }) {
        return Some(WorktreeCheckout::new(record.clone()));
    }
    let summary_by_id: HashMap<u64, &Json> = summaries
        .iter()
        .filter_map(|summary| num_key(summary.get("id")).map(|sid| (sid, summary)))
        .collect();
    let mut seen = HashSet::new();
    let mut current = summary_by_id.get(&id).copied();
    while let Some(summary) = current {
        let sid = match num_key(summary.get("id")) {
            Some(sid) if seen.insert(sid) => sid,
            _ => break,
        };
        if let Some(record) = checkouts.and_then(|list| {
            list.iter().find(|checkout| num_key(checkout.get("conversationId")) == Some(sid))
        }) {
            return Some(WorktreeCheckout::new(record.clone()));
        }
        current = num_key(summary.get("parent")).and_then(|pid| summary_by_id.get(&pid).copied());
    }
    None
}
