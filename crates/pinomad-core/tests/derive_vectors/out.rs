// Test-only serialization of the typed derivation outputs back into the Json
// the vectors compare — kept out of the public API per the step-2 brief: the
// production boundary is UniFFI, not JSON.
use std::rc::Rc;

use pinomad_core::chat::{AgentState, QueueItem, TaskRow, UsageRow};
use pinomad_core::cot_view::{ChatEntry, CotStep, CotView, LiftedSubagent, RetryRequest, SplitSubagents};
use pinomad_core::json::{Json, JsonObject};
use pinomad_core::presentation::ClassifiedDoc;
use pinomad_core::tool_item::{DiffStat, MessageImage, PinomadToolDetail, ToolItem};
use pinomad_core::u16str::U16String;

fn s(text: &str) -> Json {
    Json::String(U16String::from_str(text))
}

/// `{key: value}` in JS object order; `None` values mean the reference omits
/// the field — JSON.stringify drops undefined, never emits null there.
fn obj(pairs: &[(&str, Option<Json>)]) -> Json {
    let mut object = JsonObject::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            object.set(U16String::from_str(key), value.clone());
        }
    }
    Json::Object(Rc::new(object))
}

fn num(value: f64) -> Json {
    Json::Number(value)
}

fn image_json(image: &MessageImage) -> Json {
    obj(&[
        ("data", Some(s(&image.data))),
        ("mimeType", Some(s(&image.mime_type))),
    ])
}

fn diff_stat_json(stat: &DiffStat) -> Json {
    obj(&[
        ("additions", Some(num(stat.additions))),
        ("deletions", Some(num(stat.deletions))),
    ])
}

fn pinomad_json(detail: &PinomadToolDetail) -> Json {
    match detail {
        PinomadToolDetail::Diff { patch } => obj(&[("kind", Some(s("diff"))), ("patch", Some(s(patch)))]),
        PinomadToolDetail::Subagent {
            conversation_id,
            output,
            model,
            started_at,
            ended_at,
        } => obj(&[
            ("kind", Some(s("subagent"))),
            ("conversationId", Some(num(*conversation_id as f64))),
            ("output", output.as_deref().map(s)),
            ("model", model.as_deref().map(s)),
            ("startedAt", started_at.map(num)),
            ("endedAt", ended_at.map(num)),
        ]),
    }
}

fn tool_json(tool: &ToolItem) -> Json {
    obj(&[
        ("state", Some(s(tool.state.as_str()))),
        ("toolCallId", tool.tool_call_id.as_deref().map(s)),
        ("toolName", tool.tool_name.as_deref().map(s)),
        ("argsText", tool.args_text.as_deref().map(s)),
        ("output", tool.output.as_deref().map(s)),
        ("diffStat", tool.diff_stat.as_ref().map(diff_stat_json)),
        ("durationMs", tool.duration_ms.map(num)),
        (
            "images",
            (!tool.images.is_empty()).then(|| Json::array(tool.images.iter().map(image_json).collect())),
        ),
        (
            "children",
            (!tool.children.is_empty()).then(|| Json::array(tool.children.iter().map(tool_json).collect())),
        ),
        ("pinomad", tool.pinomad.as_ref().map(pinomad_json)),
    ])
}

fn step_json(step: &CotStep) -> Json {
    match step {
        CotStep::Thinking { id, text, live } => obj(&[
            ("kind", Some(s("thinking"))),
            ("id", Some(s(id))),
            ("text", Some(s(text))),
            ("live", Some(Json::Bool(*live))),
        ]),
        CotStep::Interim { id, text } => obj(&[
            ("kind", Some(s("interim"))),
            ("id", Some(s(id))),
            ("text", Some(s(text))),
        ]),
        CotStep::Tools {
            id,
            tools,
            live,
            active_tool_call_id,
        } => obj(&[
            ("kind", Some(s("tools"))),
            ("id", Some(s(id))),
            ("tools", Some(Json::array(tools.iter().map(tool_json).collect()))),
            ("live", Some(Json::Bool(*live))),
            ("activeToolCallId", active_tool_call_id.as_deref().map(s)),
        ]),
    }
}

pub fn cot_json(cot: &CotView) -> Json {
    obj(&[
        ("phase", Some(s(cot.phase.as_str()))),
        ("outcome", cot.failed.then(|| s("failed"))),
        ("anchorMs", cot.anchor_ms.map(num)),
        ("elapsedMs", cot.elapsed_ms.map(num)),
        ("steps", Some(Json::array(cot.steps.iter().map(step_json).collect()))),
        (
            "answer",
            cot.answer
                .as_ref()
                .map(|a| obj(&[("text", Some(s(&a.text))), ("streaming", Some(Json::Bool(a.streaming)))])),
        ),
    ])
}

pub fn chat_entry_json(entry: &ChatEntry) -> Json {
    match entry {
        ChatEntry::User { id, text, images } => obj(&[
            ("kind", Some(s("user"))),
            ("id", Some(s(id))),
            ("text", Some(s(text))),
            ("images", Some(Json::array(images.iter().map(image_json).collect()))),
        ]),
        ChatEntry::Run {
            id,
            cot,
            fork_entry_id,
            interrupted,
            failure,
        } => obj(&[
            ("kind", Some(s("run"))),
            ("id", Some(s(id))),
            ("cot", Some(cot_json(cot))),
            ("interrupted", Some(Json::Bool(*interrupted))),
            ("forkEntryId", fork_entry_id.as_deref().map(s)),
            ("failure", failure.as_deref().map(s)),
        ]),
        ChatEntry::Compaction { id } => obj(&[("kind", Some(s("compaction"))), ("id", Some(s(id)))]),
        ChatEntry::Reset { id } => obj(&[("kind", Some(s("reset"))), ("id", Some(s(id)))]),
    }
}

pub fn chat_entries_json(entries: &[ChatEntry]) -> Json {
    Json::array(entries.iter().map(chat_entry_json).collect())
}

pub fn retry_json(retry: Option<&RetryRequest>) -> Json {
    match retry {
        None => Json::Null,
        Some(r) => obj(&[
            ("text", Some(s(&r.text))),
            ("images", Some(Json::array(r.images.iter().map(image_json).collect()))),
            ("requestId", Some(s(&r.request_id))),
        ]),
    }
}

pub fn split_json(split: &SplitSubagents) -> Json {
    obj(&[
        ("view", Some(cot_json(&split.view))),
        (
            "subagents",
            Some(Json::array(
                split
                    .subagents
                    .iter()
                    .map(|sub| {
                        let LiftedSubagent { key, tool } = sub;
                        obj(&[("key", Some(s(key))), ("tool", Some(tool_json(tool)))])
                    })
                    .collect(),
            )),
        ),
    ])
}

pub fn agent_json(agent: &AgentState) -> Json {
    agent.to_json()
}

pub fn queue_items_json(items: &[QueueItem]) -> Json {
    Json::array(
        items
            .iter()
            .map(|item| {
                obj(&[
                    ("id", Some(num(item.id as f64))),
                    ("mode", Some(s(item.mode.as_str()))),
                    ("text", Some(s(&item.text))),
                    ("imageCount", Some(num(item.image_count as f64))),
                ])
            })
            .collect(),
    )
}

pub fn usage_rows_json(rows: &[UsageRow]) -> Json {
    Json::array(
        rows.iter()
            .map(|row| {
                obj(&[
                    ("key", Some(s(&row.key))),
                    ("input", row.input.map(num)),
                    ("output", row.output.map(num)),
                    ("cost", row.cost.map(num)),
                ])
            })
            .collect(),
    )
}

pub fn task_rows_json(rows: &[TaskRow]) -> Json {
    Json::array(
        rows.iter()
            .map(|row| {
                obj(&[
                    ("id", Some(num(row.id as f64))),
                    ("depth", Some(num(row.depth as f64))),
                    ("label", Some(s(&row.label))),
                ])
            })
            .collect(),
    )
}

pub fn classified_json(classified: &ClassifiedDoc) -> Json {
    obj(&[
        ("type", Some(s(classified.doc_type().as_str()))),
        ("value", Some(classified.to_json())),
    ])
}

use pinomad_core::family::TaskGroup;
use pinomad_core::folder_path::FolderCrumb;
use pinomad_core::model::{ModelPick, ModelRef};
use pinomad_core::organization::ConversationNode;
use pinomad_core::questions::{PendingQuestion, QuestionAnswer};
use pinomad_core::stored_host::StoredHost;

fn nodes_json(nodes: &[ConversationNode]) -> Json {
    Json::array(nodes.iter().map(|n| n.to_json()).collect())
}

pub fn threads_json(nodes: &[ConversationNode]) -> Json {
    nodes_json(nodes)
}

pub fn task_groups_json(groups: &[TaskGroup]) -> Json {
    Json::array(
        groups
            .iter()
            .map(|group| {
                obj(&[
                    ("owner", Some(group.owner.to_json())),
                    ("label", Some(s(&group.label))),
                    ("tasks", Some(nodes_json(&group.tasks))),
                ])
            })
            .collect(),
    )
}

pub fn pending_questions_json(items: &[PendingQuestion]) -> Json {
    Json::array(
        items
            .iter()
            .map(|item| {
                obj(&[("kind", Some(s(&item.kind))), ("request", Some(item.request.to_json()))])
            })
            .collect(),
    )
}

pub fn question_answers_json(items: &[QuestionAnswer]) -> Json {
    Json::array(
        items
            .iter()
            .map(|a| {
                obj(&[
                    ("selected", Some(Json::array(a.selected.iter().map(|v| s(v)).collect()))),
                    ("other", a.other.as_deref().map(s)),
                ])
            })
            .collect(),
    )
}

pub fn folder_crumbs_json(crumbs: &[FolderCrumb]) -> Json {
    Json::array(
        crumbs
            .iter()
            .map(|c| obj(&[("label", Some(s(&c.label))), ("path", Some(s(&c.path)))]))
            .collect(),
    )
}

pub fn stored_host_json(host: Option<&StoredHost>) -> Json {
    let Some(host) = host else {
        return Json::Null;
    };
    obj(&[
        ("url", Some(s(&host.url))),
        ("hostKey", Some(s(&host.host_key))),
        ("privateKey", Some(s(&host.private_key))),
        ("account", host.account.as_ref().map(|a| a.to_json())),
    ])
}

pub fn host_labels_json(labels: &[pinomad_core::stored_host::HostLabel]) -> Json {
    let mut object = JsonObject::new();
    for entry in labels {
        object.set(U16String::from_str(&entry.host_key), s(&entry.label));
    }
    Json::Object(Rc::new(object))
}

pub fn model_pick_json(pick: &ModelPick) -> Json {
    obj(&[
        ("model", pick.model.as_ref().map(ModelRef::to_json)),
        ("level", Some(Json::String(U16String::from_str(pick.level.as_str())))),
    ])
}

/// The `thinkingLevelLabels` map in the reference's key order.
pub fn level_labels_json() -> Json {
    let mut object = JsonObject::new();
    for level in pinomad_core::model::ThinkingLevel::ORDER {
        let label = pinomad_core::model::thinking_level_label(&pinomad_core::model::ThinkingLevel::from_units(
            &level.encode_utf16().collect::<Vec<u16>>(),
        ))
        .unwrap();
        object.set(U16String::from_str(level), s(&label));
    }
    Json::Object(Rc::new(object))
}
