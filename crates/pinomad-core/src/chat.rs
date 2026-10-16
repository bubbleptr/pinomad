// What a graphical client shows for a conversation view, as plain data —
// packages/client/src/chat.ts. The derivations follow pi's durable TUI so
// every client tells the same story.

use std::collections::HashSet;

use crate::json::{js_strict_eq, same_value_zero, JsKey, Json};
use crate::text;
use crate::u16str::U16String;

/// `pi.agent` — the conversation's agent doc (model, thinking level, cwd).
/// The raw document is kept verbatim: the reference returns it untouched.
#[derive(Clone, Debug)]
pub struct AgentState {
    pub raw: Json,
}

impl AgentState {
    pub fn model(&self) -> Option<&Json> {
        self.raw.get("model")
    }

    pub fn thinking_level(&self) -> Option<&Json> {
        self.raw.get("thinkingLevel")
    }
}

fn not_null(value: Option<&Json>) -> Option<&Json> {
    value.filter(|v| !matches!(v, Json::Null))
}

fn str_eq(value: Option<&Json>, literal: &str) -> bool {
    value
        .and_then(Json::as_str)
        .is_some_and(|s| s.units() == U16String::from_str(literal).units())
}

/// `String(value)` → UI text: undefined renders "undefined", lone surrogates
/// become U+FFFD.
fn js_text(value: Option<&Json>) -> String {
    U16String(text::string_of(value)).to_string_lossy()
}

/// `agentOf(view)` — `docs["pi.agent"] ?? {}`.
pub fn agent_of(view: &Json) -> AgentState {
    AgentState {
        raw: not_null(view.get("docs").and_then(|docs| docs.get("pi.agent")))
            .cloned()
            .unwrap_or_else(Json::object),
    }
}

fn live_of(view: &Json) -> Option<&Json> {
    not_null(view.get("docs").and_then(|docs| docs.get("pi.live")))
}

fn text_of(content: Option<&Json>) -> String {
    match content {
        Some(Json::String(s)) => s.to_string_lossy(),
        Some(Json::Array(items)) => {
            let mut out = Vec::new();
            for block in items.iter() {
                if str_eq(block.get("type"), "text") {
                    if let Some(text) = block.get("text") {
                        if !matches!(text, Json::Null) {
                            out.extend_from_slice(&U16String::js_string(text).0);
                        }
                    }
                }
            }
            U16String(out).to_string_lossy()
        }
        _ => String::new(),
    }
}

fn image_count_of(content: Option<&Json>) -> f64 {
    match content {
        Some(Json::Array(items)) => items.iter().filter(|b| str_eq(b.get("type"), "image")).count() as f64,
        _ => 0.0,
    }
}

/// `statusText(view)` — what the conversation is doing beyond the run itself,
/// most specific first; empty when idle or just busy.
pub fn status_text(view: &Json) -> String {
    let empty = Json::object();
    let live = live_of(view).unwrap_or(&empty);
    let generation = live.get("generation");
    let compaction = live.get("compactions").and_then(Json::as_array).and_then(|c| c.first());
    let retry = generation.and_then(|g| g.get("retry"));
    if retry.is_some() {
        return format!(
            "Retrying (attempt {}): {}",
            U16String(text::plus_one(generation.and_then(|g| g.get("attempt")))).to_string_lossy(),
            js_text(retry.and_then(|r| r.get("error"))),
        );
    }
    if generation.and_then(|g| g.get("deferred")).is_some() {
        return "Waiting for deferred response...".to_string();
    }
    if let Some(compaction) = compaction {
        return if compaction.get("retry").is_some_and(Json::truthy) {
            format!(
                "Retrying {} compaction (attempt {})...",
                js_text(compaction.get("reason")),
                U16String(text::plus_one(compaction.get("attempt"))).to_string_lossy(),
            )
        } else {
            format!("Compacting ({})...", js_text(compaction.get("reason")))
        };
    }
    String::new()
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueueItem {
    pub id: f64,
    pub mode: String,
    pub text: String,
    /// Image blocks attached to the queued input; 0 on "write" items.
    pub image_count: f64,
}

/// `queueItems(view)` — the queued inputs with their mode.
pub fn queue_items(view: &Json) -> Vec<QueueItem> {
    let inbox = not_null(view.get("docs").and_then(|docs| docs.get("pi.inbox")));
    let items = inbox.and_then(|i| i.get("items")).and_then(Json::as_array);
    items
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let write = str_eq(item.get("mode"), "write");
                    QueueItem {
                        id: item.get("id").and_then(Json::as_number).unwrap_or(f64::NAN),
                        mode: js_text(item.get("mode")),
                        text: if write {
                            format!("<{}>", js_text(item.get("entry").and_then(|e| e.get("kind"))))
                        } else {
                            text_of(item.get("content"))
                        },
                        image_count: if write { 0.0 } else { image_count_of(item.get("content")) },
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageRow {
    /// `provider/model` of model responses, or a tool name.
    pub key: String,
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cost: Option<f64>,
}

/// `usageRows(view)` — spend of the shown conversation, as `pi.usage` totals
/// it; failed and aborted attempts count.
pub fn usage_rows(view: &Json) -> Vec<UsageRow> {
    let Some(usage) = view.get("docs").and_then(|docs| docs.get("pi.usage")) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for bucket in ["models", "tools"] {
        if let Some(map) = usage.get(bucket).and_then(Json::as_object) {
            for (key, value) in map.iter() {
                rows.push(UsageRow {
                    key: key.to_string_lossy(),
                    input: value.get("input").and_then(Json::as_number),
                    output: value.get("output").and_then(Json::as_number),
                    cost: value.get("cost").and_then(|c| c.get("total")).and_then(Json::as_number),
                });
            }
        }
    }
    rows
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskRow {
    pub id: f64,
    pub depth: f64,
    pub label: String,
}

/// `Array#join(", ")` — null/undefined elements render empty.
fn join_of(list: Option<&Json>) -> Vec<u16> {
    let mut out = Vec::new();
    if let Some(Json::Array(items)) = list {
        for (index, item) in items.iter().enumerate() {
            if index > 0 {
                out.extend_from_slice(&[b',' as u16, b' ' as u16]);
            }
            if !matches!(item, Json::Null) {
                out.extend_from_slice(&U16String::js_string(item).0);
            }
        }
    }
    out
}

fn describe_task(node: &Json) -> String {
    let state = node.get("state");
    let status = if str_eq(state.and_then(|s| s.get("status")), "waiting") {
        format!("waiting on {}", U16String(join_of(state.and_then(|s| s.get("on")))).to_string_lossy())
    } else if str_eq(state.and_then(|s| s.get("status")), "completing") {
        format!("completing ({})", js_text(state.and_then(|s| s.get("outcome"))))
    } else {
        format!(
            "{} {}",
            js_text(state.and_then(|s| s.get("status"))),
            js_text(state.and_then(|s| s.get("phase")))
        )
    };
    let mut flags = Vec::new();
    if node.get("background").is_some_and(Json::truthy) {
        flags.push("background");
    }
    if node.get("abortRequested").is_some_and(Json::truthy) {
        flags.push("aborting");
    }
    let flags_text = if flags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", flags.join(", "))
    };
    let conversations = node.get("conversations").and_then(Json::as_array);
    let owned = match conversations {
        Some(list) if !list.is_empty() => {
            format!(" owns conversation {}", U16String(join_of(node.get("conversations"))).to_string_lossy())
        }
        _ => String::new(),
    };
    format!(
        "{} #{}: {}{}{}",
        js_text(node.get("kind")),
        js_text(node.get("id")),
        status,
        flags_text,
        owned
    )
}

/// `taskRows(graph)` — live tasks as an indented tree: owned work under its
/// owner, a subagent's work under the call that owns its conversation.
pub fn task_rows(graph: &Json) -> Vec<TaskRow> {
    let Some(tasks) = graph.get("tasks").and_then(Json::as_object) else {
        return Vec::new();
    };
    let nodes: Vec<&Json> = tasks.iter().map(|(_, node)| node).collect();
    // `nodes.flatMap(node => node.conversations)` — a non-array value joins
    // the set as a single element, like flatMap does.
    let owned: HashSet<JsKey> = nodes
        .iter()
        .flat_map(|node| match node.get("conversations").and_then(Json::as_array) {
            Some(list) => list.iter().map(|v| JsKey::of(Some(v))).collect::<Vec<JsKey>>(),
            None => vec![JsKey::of(node.get("conversations"))],
        })
        .collect();
    let mut rows = Vec::new();
    for node in &nodes {
        if node.get("owner").is_none() && !owned.contains(&JsKey::of(node.get("conversationId"))) {
            visit_task(node, 0.0, &nodes, &mut rows);
        }
    }
    rows
}

/// `a === b` where either side may be absent (`undefined === undefined`).
fn js_strict_eq_opt(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => js_strict_eq(x, y),
        _ => false,
    }
}

fn visit_task<'a>(node: &'a Json, depth: f64, nodes: &[&'a Json], rows: &mut Vec<TaskRow>) {
    rows.push(TaskRow {
        id: node.get("id").and_then(Json::as_number).unwrap_or(f64::NAN),
        depth,
        label: describe_task(node),
    });
    for candidate in nodes.iter().copied() {
        let child = js_strict_eq_opt(candidate.get("owner"), node.get("id"))
            || (candidate.get("owner").is_none()
                && node.get("conversations").and_then(Json::as_array).is_some_and(|list| {
                    candidate
                        .get("conversationId")
                        .is_some_and(|id| list.iter().any(|v| same_value_zero(v, id)))
                }));
        if child {
            visit_task(candidate, depth + 1.0, nodes, rows);
        }
    }
}
