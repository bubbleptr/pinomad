// The conversation family's rolled-up presentation from
// packages/client/src/family.ts: root rows speak for the whole family (forks
// and subagents never get rows of their own), so status and recency aggregate
// across the root and every descendant.
use crate::json::Json;
use crate::organization::{
    find_conversation, ConversationNode, ConversationStatus, ConversationSummary, Organized, SummaryKind,
};
use crate::text;
use crate::u16str::U16String;

// Deliberately NOT the host's per-conversation precedence (needs-answer >
// running > failed): at family level a failure somewhere matters more than
// something merely still in flight.
fn status_rank(status: &ConversationStatus) -> Option<u8> {
    match status {
        ConversationStatus::NeedsAnswer => Some(3),
        ConversationStatus::Failed => Some(2),
        ConversationStatus::Running => Some(1),
        ConversationStatus::Other(_) => None,
    }
}

/// `familyStatus`: the most urgent status among the root and all of its
/// descendants. The TS rank table only knows the three statuses; an unknown
/// one can still become `best` when nothing ranked precedes it
/// (`undefined > undefined` is false), so `Other` passes through. A status
/// that is not a string at all is malformed — it decodes to `None` and drops
/// out of the rollup where the reference would have emitted it raw.
pub fn family_status(node: &ConversationNode) -> Option<ConversationStatus> {
    let mut best: Option<ConversationStatus> = None;
    fn walk(node: &ConversationNode, best: &mut Option<ConversationStatus>) {
        if let Some(status) = &node.summary.status {
            let better = match best.as_ref() {
                None => true,
                Some(b) => match (status_rank(status), status_rank(b)) {
                    (Some(s), Some(b)) => s > b,
                    _ => false,
                },
            };
            if better {
                *best = Some(status.clone());
            }
        }
        for child in &node.children {
            walk(child, best);
        }
    }
    walk(node, &mut best);
    best
}

/// `familyUpdatedAt`: the freshest `updatedAt` among the root and all of its
/// descendants, skipping summaries without one.
pub fn family_updated_at(node: &ConversationNode) -> Option<f64> {
    let mut newest: Option<f64> = None;
    fn walk(node: &ConversationNode, newest: &mut Option<f64>) {
        if let Some(at) = node.summary.raw().get("updatedAt") {
            // `at !== undefined` covers a non-number value too: it wins the
            // empty-family slot (TS keeps the raw value) and then loses every
            // `>` comparison — NaN reproduces both.
            let value = at.as_number().unwrap_or(f64::NAN);
            if newest.is_none() {
                *newest = Some(value);
            } else if let Some(a) = at.as_number() {
                if a > newest.unwrap() {
                    *newest = Some(a);
                }
            }
        }
        for child in &node.children {
            walk(child, newest);
        }
    }
    walk(node, &mut newest);
    newest
}

fn js_num(value: f64) -> String {
    U16String(crate::json::number_to_units(value)).to_string_lossy()
}

/// `relativeTime`: "now" under a minute, then floored units. JS Math.max(0,
/// NaN) is NaN, not 0 — the whole chain then lands on "NaNd" like the
/// reference.
pub fn relative_time(at: f64, now: f64) -> String {
    let raw = ((now - at) / 1000.0).floor();
    let seconds = if raw.is_nan() { f64::NAN } else { raw.max(0.0) };
    if seconds < 60.0 {
        return "now".to_string();
    }
    let minutes = (seconds / 60.0).floor();
    if minutes < 60.0 {
        return format!("{}m", js_num(minutes));
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        return format!("{}h", js_num(hours));
    }
    format!("{}d", js_num((hours / 24.0).floor()))
}

// Delegating models often open a task with this clause; it says nothing about
// what the work is. SUBAGENT_TASK_PREFIX = /^\s*in the working directory\s+\S+,\s*/i
fn subagent_task_prefix_len(units: &[u16]) -> Option<usize> {
    let lit: Vec<u16> = "in the working directory".encode_utf16().collect();
    let mut pos = 0;
    while pos < units.len() && text::is_js_space(units[pos]) {
        pos += 1;
    }
    if units.len() < pos + lit.len() {
        return None;
    }
    for (i, &l) in lit.iter().enumerate() {
        if text::canon(units[pos + i]) != text::canon(l) {
            return None;
        }
    }
    pos += lit.len();
    let spaces = pos;
    while pos < units.len() && text::is_js_space(units[pos]) {
        pos += 1;
    }
    if pos == spaces {
        return None; // \s+ required
    }
    let non_spaces = pos;
    while pos < units.len() && !text::is_js_space(units[pos]) {
        pos += 1;
    }
    if pos == non_spaces {
        return None; // \S+ required
    }
    // JS backtracks the greedy \S+ until the `,` literal matches — the
    // rightmost comma in the non-space run (with at least one unit before it).
    let comma = units[non_spaces + 1..pos]
        .iter()
        .rposition(|&u| u == b',' as u16)
        .map(|i| non_spaces + 1 + i)?;
    pos = comma + 1;
    while pos < units.len() && text::is_js_space(units[pos]) {
        pos += 1;
    }
    Some(pos)
}

fn str_eq(value: Option<&Json>, want: &str) -> bool {
    value
        .and_then(Json::as_str)
        .is_some_and(|s| s.units() == want.encode_utf16().collect::<Vec<u16>>())
}

/// `displayName`: what a conversation is called wherever the UI names it.
pub fn display_name(summary: Option<&Json>) -> String {
    let Some(summary) = summary else {
        return "Conversation".to_string();
    };
    if !str_eq(summary.get("kind"), "subagent") {
        return summary
            .get("title")
            .filter(|t| !matches!(t, Json::Null)) // `??` is nullish
            .map(|t| U16String::js_string(t).to_string_lossy())
            .unwrap_or_else(|| "New conversation".to_string());
    }
    if let Some(label) = summary.get("label") {
        // `label !== undefined`, not nullish: a null label passes through
        // String(label) here the way the reference emits it raw.
        return U16String::js_string(label).to_string_lossy();
    }
    let title = summary.get("title").and_then(Json::as_str).map(|t| {
        let units = t.units();
        let rest = subagent_task_prefix_len(units)
            .map(|len| text::slice(units, len as i64, None))
            .unwrap_or_else(|| units.to_vec());
        text::trim(&rest).to_vec()
    });
    match title {
        Some(title) if !title.is_empty() => U16String(title).to_string_lossy(),
        _ => "Subagent".to_string(),
    }
}

/// `rootOf`: the top-level node a conversation belongs to — `parent` links
/// walked to the root. The depth guard mirrors the reference's.
pub fn root_of(organized: &Organized, id: u64) -> Option<ConversationNode> {
    let mut found = find_conversation(organized, id);
    // A present-but-unresolvable parent still replaces `found` — a miss
    // returns undefined, not the previous link.
    for _depth in 0..4 {
        let Some(node) = &found else { break };
        if node.summary.raw().get("parent").is_none() {
            break;
        }
        found = node.summary.parent.and_then(|parent| find_conversation(organized, parent));
    }
    found
}

/// `threadsOf`: the family's forks, depth-first so a fork of a fork follows
/// its parent fork rather than disappearing (pre-depth-of-one data).
pub fn threads_of(root: &ConversationNode) -> Vec<ConversationNode> {
    let mut threads = Vec::new();
    fn walk(node: &ConversationNode, out: &mut Vec<ConversationNode>) {
        for child in &node.children {
            if child.summary.kind == Some(SummaryKind::Fork) {
                out.push(child.clone());
                walk(child, out);
            }
        }
    }
    walk(root, &mut threads);
    threads
}

/// One row of `taskGroupsOf`: the owner summary, its label, its subagents.
#[derive(Clone, Debug)]
pub struct TaskGroup {
    pub owner: ConversationSummary,
    pub label: String,
    pub tasks: Vec<ConversationNode>,
}

/// `taskGroupsOf`: the family's subagents grouped by owner — the root first,
/// then each fork that has any.
pub fn task_groups_of(root: &ConversationNode) -> Vec<TaskGroup> {
    let mut groups = Vec::new();
    let own: Vec<ConversationNode> = root
        .children
        .iter()
        .filter(|child| child.summary.kind == Some(SummaryKind::Subagent))
        .cloned()
        .collect();
    if !own.is_empty() {
        groups.push(TaskGroup {
            owner: root.summary.clone(),
            label: "This conversation".to_string(),
            tasks: own,
        });
    }
    for fork in threads_of(root) {
        let tasks: Vec<ConversationNode> = fork
            .children
            .iter()
            .filter(|child| child.summary.kind == Some(SummaryKind::Subagent))
            .cloned()
            .collect();
        if !tasks.is_empty() {
            groups.push(TaskGroup {
                owner: fork.summary.clone(),
                label: display_name(Some(fork.summary.raw())),
                tasks,
            });
        }
    }
    groups
}

/// `forksAt`: the forks anchored at one of a conversation's entries — the
/// "N forks" chip's targets.
pub fn forks_at(organized: &Organized, conversation_id: u64, entry_id: &str) -> Vec<u64> {
    find_conversation(organized, conversation_id)
        .map(|node| {
            node.children
                .iter()
                .filter(|child| child.summary.forked_at.as_deref() == Some(entry_id))
                .filter_map(|child| child.summary.id)
                .collect()
        })
        .unwrap_or_default()
}
