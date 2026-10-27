// Test-only serialization of the typed derivation outputs back into the Json
// the vectors compare — kept out of the public API per the step-2 brief: the
// production boundary is UniFFI, not JSON.
use std::sync::Arc;

use pinomad_core::chat::{AgentState, QueueItem, QueuedInput, TaskRow, UsageRow};
use pinomad_core::cot_view::{
    ChatEntry, CotStep, CotView, LiftedSubagent, LocalQueueRow, RetryRequest, SplitSubagents, SubmissionRow,
};
use pinomad_core::json::{Json, JsonObject};
use pinomad_core::presentation::ClassifiedDoc;
use pinomad_core::skill_blocks::UserAttachment;
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
    Json::Object(Arc::new(object))
}

fn num(value: f64) -> Json {
    Json::Number(value)
}

fn image_json(image: &MessageImage) -> Json {
    match &image.ref_ {
        Some(reference) if image.data.is_empty() => obj(&[
            ("ref", Some(s(reference))),
            ("mimeType", Some(s(&image.mime_type))),
        ]),
        _ => obj(&[
            ("data", Some(s(&image.data))),
            ("mimeType", Some(s(&image.mime_type))),
        ]),
    }
}

fn attachment_json(file: &UserAttachment) -> Json {
    obj(&[
        ("id", Some(s(&file.id))),
        ("name", Some(s(&file.name))),
        ("size", Some(num(file.size as f64))),
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
        ("todoWrittenAtMs", cot.todo_written_at_ms.map(num)),
        ("model", cot.model.as_ref().map(ModelRef::to_json)),
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
        ChatEntry::User { id, text, images, skills, attachments, timestamp } => obj(&[
            ("kind", Some(s("user"))),
            ("id", Some(s(id))),
            ("text", Some(s(text))),
            ("images", Some(Json::array(images.iter().map(image_json).collect()))),
            ("skills", Some(Json::array(skills.iter().map(|name| s(name)).collect()))),
            (
                "attachments",
                Some(Json::array(attachments.iter().map(attachment_json).collect())),
            ),
            ("timestamp", timestamp.map(num)),
        ]),
        ChatEntry::Run {
            id,
            cot,
            fork_entry_id,
            interrupted,
            failure,
            ended_at,
        } => obj(&[
            ("kind", Some(s("run"))),
            ("id", Some(s(id))),
            ("cot", Some(cot_json(cot))),
            ("interrupted", Some(Json::Bool(*interrupted))),
            ("forkEntryId", fork_entry_id.as_deref().map(s)),
            ("failure", failure.as_deref().map(s)),
            ("endedAt", ended_at.map(num)),
        ]),
        ChatEntry::Compaction { id } => obj(&[("kind", Some(s("compaction"))), ("id", Some(s(id)))]),
        ChatEntry::Reset { id } => obj(&[("kind", Some(s("reset"))), ("id", Some(s(id)))]),
    }
}

/// The reference's final list: committed entries plus the local rows, with
/// `status`/\`local\` fields the FFI enum deliberately does not carry yet.
pub fn chat_entries_with_submissions_json(entries: &[ChatEntry], rows: &[SubmissionRow]) -> Json {
    let mut items: Vec<Json> = entries.iter().map(chat_entry_json).collect();
    if let Some(latest) = items
        .iter_mut()
        .rev()
        .find(|item| item.get("kind").and_then(Json::as_str).is_some_and(|kind| kind.to_string_lossy() == "user"))
    {
        if let Json::Object(object) = latest {
            let mut copy = object.as_ref().clone();
            copy.set(U16String::from_str("status"), s("delivered"));
            *latest = Json::Object(Arc::new(copy));
        }
    }
    for row in rows {
        let mut local = JsonObject::new();
        local.set(U16String::from_str("requestId"), s(&row.request_id));
        if let Some(error) = &row.error {
            local.set(U16String::from_str("error"), s(error));
        }
        items.push(obj(&[
            ("kind", Some(s("user"))),
            ("id", Some(s(&format!("local:{}", row.request_id)))),
            ("text", Some(s(&row.text))),
            ("images", Some(Json::array(row.images.iter().map(image_json).collect()))),
            (
                "attachments",
                Some(Json::array(row.attachments.iter().map(attachment_json).collect())),
            ),
            ("skills", Some(Json::array(row.skills.iter().map(|name| s(name)).collect()))),
            ("status", Some(s(&row.status))),
            ("local", Some(Json::Object(Arc::new(local)))),
        ]));
    }
    Json::array(items)
}

pub fn queue_items_with_submissions_json(host: &[QueueItem], rows: &[LocalQueueRow]) -> Json {
    let mut items: Vec<Json> = host
        .iter()
        .map(|item| {
            obj(&[
                ("id", Some(num(item.id as f64))),
                ("mode", Some(s(item.mode.as_str()))),
                ("text", Some(s(&item.text))),
                ("imageCount", Some(num(item.image_count as f64))),
                ("attachmentCount", Some(num(item.attachment_count as f64))),
                ("status", Some(s("sent"))),
            ])
        })
        .collect();
    for row in rows {
        let mut local = JsonObject::new();
        if let Some(error) = &row.error {
            local.set(U16String::from_str("error"), s(error));
        }
        items.push(obj(&[
            ("requestId", Some(s(&row.request_id))),
            ("mode", Some(s(&row.mode))),
            ("text", Some(s(&row.text))),
            ("imageCount", Some(num(row.image_count as f64))),
            ("attachmentCount", Some(num(row.attachment_count as f64))),
            ("status", Some(s(&row.status))),
            ("local", Some(Json::Object(Arc::new(local)))),
        ]));
    }
    Json::array(items)
}

pub fn retry_json(retry: Option<&RetryRequest>) -> Json {
    match retry {
        None => Json::Null,
        Some(r) => obj(&[
            ("text", Some(s(&r.text))),
            ("images", Some(Json::array(r.images.iter().map(image_json).collect()))),
            ("skills", Some(Json::array(r.skills.iter().map(|n| s(n)).collect()))),
            (
                "attachments",
                Some(Json::array(r.attachments.iter().map(attachment_json).collect())),
            ),
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

pub fn queued_input_json(input: &QueuedInput) -> Json {
    obj(&[
        ("text", Some(s(&input.text))),
        (
            "images",
            Some(Json::array(input.images.iter().map(image_json).collect())),
        ),
        ("skills", Some(Json::array(input.skills.iter().map(|name| s(name)).collect()))),
        (
            "attachments",
            Some(Json::array(input.attachments.iter().map(attachment_json).collect())),
        ),
    ])
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

/// `{used, window}` in the reference's key order.
pub fn context_usage_json(usage: &pinomad_core::context_usage::ContextUsage) -> Json {
    obj(&[("used", Some(num(usage.used))), ("window", Some(num(usage.window)))])
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
        ("name", host.name.as_ref().map(|n| s(n))),
        ("account", host.account.as_ref().map(|a| a.to_json())),
        ("endpointSet", host.endpoint_set.as_ref().map(|set| set.to_json())),
    ])
}


pub fn host_labels_json(labels: &[pinomad_core::stored_host::HostLabel]) -> Json {
    let mut object = JsonObject::new();
    for entry in labels {
        object.set(U16String::from_str(&entry.host_key), s(&entry.label));
    }
    Json::Object(Arc::new(object))
}

pub fn model_pick_json(pick: &ModelPick) -> Json {
    obj(&[
        ("model", pick.model.as_ref().map(ModelRef::to_json)),
        ("level", Some(Json::String(U16String::from_str(pick.level.as_str())))),
    ])
}

fn agent_draft_problem_json(problem: &pinomad_core::model::AgentDraftProblem) -> Json {
    use pinomad_core::model::AgentDraftProblem;
    match problem {
        AgentDraftProblem::AgentMissing { agent, reason } => obj(&[
            ("kind", Some(s("agent-missing"))),
            ("agent", Some(s(agent))),
            ("reason", reason.as_deref().map(s)),
        ]),
        AgentDraftProblem::ModelMissing { agent } => obj(&[
            ("kind", Some(s("model-missing"))),
            ("agent", Some(s(agent))),
        ]),
        AgentDraftProblem::ModelUnavailable { agent, model, source } => obj(&[
            ("kind", Some(s("model-unavailable"))),
            ("agent", Some(s(agent))),
            ("model", Some(model.to_json())),
            ("source", Some(s(source.as_str()))),
        ]),
    }
}

/// `AgentDraftResolution` in the reference's key order; `agent` is the input
/// the `send` object echoes.
pub fn agent_draft_json(draft: &pinomad_core::model::AgentDraft, agent: &str) -> Json {
    obj(&[
        ("model", draft.model.as_ref().map(ModelRef::to_json)),
        ("level", Some(s(draft.level.as_str()))),
        ("modelFrom", draft.model_from.map(|from| s(from.as_str()))),
        ("levelFrom", Some(s(draft.level_from.as_str()))),
        (
            "send",
            Some(obj(&[
                ("agent", Some(s(agent))),
                ("model", draft.send_model.as_ref().map(ModelRef::to_json)),
                (
                    "thinkingLevel",
                    draft.send_level.as_ref().map(|level| s(level.as_str())),
                ),
            ])),
        ),
        ("problem", draft.problem.as_ref().map(agent_draft_problem_json)),
    ])
}

/// `ParsedFile[]` in the reference's key order — `oldPath` is assigned after
/// the object literal is created, so it serializes last.
pub fn patch_files_json(files: &[pinomad_core::patch::PatchFile]) -> Json {
    Json::array(
        files
            .iter()
            .map(|file| {
                obj(&[
                    ("path", Some(s(&file.path))),
                    ("isNew", Some(Json::Bool(file.is_new))),
                    ("isDeleted", Some(Json::Bool(file.is_deleted))),
                    ("binary", Some(Json::Bool(file.binary))),
                    ("additions", Some(num(file.additions as f64))),
                    ("deletions", Some(num(file.deletions as f64))),
                    (
                        "lines",
                        Some(Json::array(
                            file.lines
                                .iter()
                                .map(|line| {
                                    obj(&[
                                        ("kind", Some(s(line.kind.as_str()))),
                                        ("text", Some(s(&line.text))),
                                    ])
                                })
                                .collect(),
                        )),
                    ),
                    ("oldPath", file.old_path.as_deref().map(s)),
                ])
            })
            .collect(),
    )
}

// ─── Account client ─────────────────────────────────────────────────────────

use pinomad_core::account::{
    AccountError, AccountHost, AccountHostMatch, AccountHttpRequest, AccountValue, JoinToken,
    LoginSuccess, PairingOffer,
};

/// The `{url, init}` the capture fetch recorded — `init` keys in the
/// reference literal's order: method, headers, then body when there is one.
pub fn account_request_json(request: &AccountHttpRequest) -> Json {
    let mut headers = JsonObject::new();
    for header in &request.headers {
        headers.set(U16String::from_str(&header.name), s(&header.value));
    }
    obj(&[
        ("url", Some(s(&request.url))),
        (
            "init",
            Some(obj(&[
                ("method", Some(s(&request.method))),
                ("headers", Some(Json::Object(Arc::new(headers)))),
                ("body", request.body.as_deref().map(s)),
            ])),
        ),
    ])
}

fn account_user_json(user: &pinomad_core::account::AccountUser) -> Json {
    obj(&[("username", Some(s(&user.username)))])
}

/// The per-op success payload, in the reference's key order.
fn account_value_json(value: &AccountValue) -> Json {
    match value {
        AccountValue::Login(LoginSuccess { user, expires_at, token }) => obj(&[
            ("user", Some(account_user_json(user))),
            ("expiresAt", Some(num(*expires_at))),
            ("token", token.as_deref().map(s)),
        ]),
        AccountValue::Me(user) => obj(&[("user", Some(account_user_json(user)))]),
        // Handled by `account_result_json` — `value` is absent, not null.
        AccountValue::Unit => Json::Null,
        AccountValue::JoinToken(JoinToken { token, expires_at, command }) => obj(&[
            ("token", Some(s(token))),
            ("expiresAt", Some(num(*expires_at))),
            ("command", Some(s(command))),
        ]),
        AccountValue::Hosts(hosts) => Json::array(hosts.iter().map(account_host_json).collect()),
        AccountValue::PairingOffer(PairingOffer { url, host_key, secret, expires_at, endpoint_set }) => {
            let mut fields = vec![
                ("url", Some(s(url))),
                ("hostKey", Some(s(host_key))),
                ("secret", Some(s(secret))),
                ("expiresAt", Some(num(*expires_at))),
            ];
            if let Some(set) = endpoint_set {
                fields.push(("endpointSet", Some(set.to_json())));
            }
            obj(&fields)
        }
    }
}

/// `AccountResult` on the wire: `{ok:true, value?}` or `{ok:false, error}` —
/// `value` drops out entirely for void results (stringify skips undefined),
/// and `error.status` is absent for client-invented codes.
pub fn account_result_json(result: &Result<AccountValue, AccountError>) -> Json {
    match result {
        Ok(AccountValue::Unit) => obj(&[("ok", Some(Json::Bool(true)))]),
        Ok(value) => obj(&[("ok", Some(Json::Bool(true))), ("value", Some(account_value_json(value)))]),
        Err(AccountError::Api { code, status }) => obj(&[
            ("ok", Some(Json::Bool(false))),
            (
                "error",
                Some(obj(&[("code", Some(s(code))), ("status", status.map(|v| num(v as f64)))])),
            ),
        ]),
    }
}

fn account_host_json(host: &AccountHost) -> Json {
    obj(&[
        ("hostId", Some(s(&host.host_id))),
        ("name", Some(s(&host.name))),
        ("noisePublicKey", Some(s(&host.noise_public_key))),
        ("online", Some(Json::Bool(host.online))),
        ("lastSeenAt", Some(num(host.last_seen_at))),
        ("pairing", Some(s(host.pairing.as_str()))),
    ])
}

/// `{host, status, stored?, linkable}` — `stored` only when a stored entry
/// backs the verdict.
pub fn account_match_json(m: &AccountHostMatch) -> Json {
    obj(&[
        ("host", Some(account_host_json(&m.host))),
        ("status", Some(s(m.status.as_str()))),
        ("stored", m.stored.as_ref().map(|host| stored_host_json(Some(host)))),
        ("linkable", Some(Json::Bool(m.linkable))),
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
    Json::Object(Arc::new(object))
}
