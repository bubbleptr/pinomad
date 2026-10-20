// The chain-of-thought derivation from packages/client/src/cot-view.ts: a
// ConversationView-shaped Json — `pi.user` / `pi.assistant` / `pi.tool-result`
// entries plus the `pi.live` doc — becomes the typed entries a chat UI
// renders. Item ids are byte-identical to the reference (`run-<first
// assistant entry id>`, `open-N`, `retry:<run id>`,
// `<step id>/<toolCallId|index>`): the UI's incremental updates key on them.

use std::collections::HashMap;

use crate::json::{js_strict_eq, JsKey, Json};
use crate::presentation::{classify, ClassifiedDoc};
use crate::text;
use crate::tool_diff_stat::stat_from_details;
use crate::tool_item::{DiffStat, MessageImage, PinomadToolDetail, ToolItem, ToolPartState};
use crate::u16str::U16String;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum CotPhase {
    Hidden,
    Thinking,
    Acting,
    Answering,
    Settled,
}

impl CotPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            CotPhase::Hidden => "hidden",
            CotPhase::Thinking => "thinking",
            CotPhase::Acting => "acting",
            CotPhase::Answering => "answering",
            CotPhase::Settled => "settled",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct CotAnswer {
    pub text: String,
    pub streaming: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum CotStep {
    Thinking {
        id: String,
        text: String,
        live: bool,
    },
    /// Text the model addressed to the user mid-run, reclassified out of the
    /// answer bubble once the same message turned out to hold a tool call.
    Interim { id: String, text: String },
    Tools {
        id: String,
        tools: Vec<ToolItem>,
        live: bool,
        /// The call currently streaming or executing, while the burst is live.
        active_tool_call_id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct CotView {
    pub phase: CotPhase,
    /// The reference's `outcome?: "failed"` — true maps back to that tag.
    pub failed: bool,
    /// The run's single clock anchor: its first surviving model call.
    pub anchor_ms: Option<f64>,
    /// Time from the run's first model call to the first answer token.
    pub elapsed_ms: Option<f64>,
    /// When this run last changed the todo list: the result time of its last
    /// successful `todo_write` (the doc commits on execution). On the view, not
    /// the `Run` variant, because Swift matches that variant positionally.
    pub todo_written_at_ms: Option<f64>,
    /// Steps in turn order; the last one may still be live.
    pub steps: Vec<CotStep>,
    /// The answer bubble's text — final, or presumed final while answering.
    pub answer: Option<CotAnswer>,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum ChatEntry {
    User {
        id: String,
        text: String,
        images: Vec<MessageImage>,
    },
    Run {
        id: String,
        cot: CotView,
        /// Entry id a fork starts from: the run's last assistant entry, only
        /// when settled and not interrupted/failed.
        fork_entry_id: Option<String>,
        interrupted: bool,
        /// Last assistant stopReason === "error": its errorMessage (or a generic text).
        failure: Option<String>,
    },
    Compaction { id: String },
    Reset { id: String },
}

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn str_eq(value: Option<&Json>, literal: &str) -> bool {
    value
        .and_then(Json::as_str)
        .is_some_and(|s| s.units() == U16String::from_str(literal).units())
}

fn lossy(units: &[u16]) -> String {
    U16String(units.to_vec()).to_string_lossy()
}

/// `value` under JS `??` — absent or null both fall through.
fn not_null(value: Option<&Json>) -> Option<&Json> {
    value.filter(|v| !matches!(v, Json::Null))
}

/// `String(value)` for a field the reference passes through raw — a close
/// approximation for the rare non-string the wire was never meant to carry.
fn string_of_value(value: Option<&Json>) -> Option<String> {
    value.map(|v| U16String::js_string(v).to_string_lossy())
}

fn text_of(content: Option<&Json>) -> Vec<u16> {
    match content {
        Some(Json::String(s)) => s.units().to_vec(),
        Some(Json::Array(items)) => {
            let mut out = Vec::new();
            for block in items.iter() {
                // `block.type === "text" && block.text !== undefined`: a null
                // text is present and contributes "" to the join.
                if str_eq(block.get("type"), "text") {
                    if let Some(text) = block.get("text") {
                        if !matches!(text, Json::Null) {
                            out.extend_from_slice(&U16String::js_string(text).0);
                        }
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

fn images_of(content: Option<&Json>) -> Vec<MessageImage> {
    let Some(Json::Array(items)) = content else { return Vec::new() };
    items
        .iter()
        .filter(|block| {
            str_eq(block.get("type"), "image") && block.get("data").is_some() && block.get("mimeType").is_some()
        })
        .map(|block| MessageImage {
            data: string_of_value(block.get("data")).unwrap_or_default(),
            mime_type: string_of_value(block.get("mimeType")).unwrap_or_default(),
        })
        .collect()
}

/// `block.type === "toolCall" && block.id !== undefined` — a null id counts.
fn is_call_block(block: &Json) -> bool {
    str_eq(block.get("type"), "toolCall") && block.get("id").is_some()
}

/// One committed assistant entry, or the run's in-flight partial.
struct RunMessage<'a> {
    id: String,
    msg: &'a Json,
    /// The `pi.live` generation partial: still streaming.
    partial: bool,
    /// Results keyed by call id, scoped to this message's own calls —
    /// providers reuse call ids across rounds.
    results: HashMap<JsKey, &'a Json>,
}

struct AssistantEntry<'a> {
    id: String,
    msg: &'a Json,
    results: HashMap<JsKey, &'a Json>,
}

struct RunDraft<'a> {
    assistants: Vec<AssistantEntry<'a>>,
    /// Results whose call id no earlier pending call in the draft claims.
    orphans: HashMap<JsKey, &'a Json>,
    /// Latest message timestamp seen inside the run (as a number; a malformed
    /// timestamp degrades to NaN like the reference's arithmetic does).
    last_ts: Option<f64>,
}

impl<'a> RunDraft<'a> {
    fn new() -> Self {
        RunDraft { assistants: Vec::new(), orphans: HashMap::new(), last_ts: None }
    }

    /// `draft.lastTs = message.timestamp ?? draft.lastTs`.
    fn note_timestamp(&mut self, message: &Json) {
        if let Some(ts) = not_null(message.get("timestamp")) {
            self.last_ts = Some(ts.as_number().unwrap_or(f64::NAN));
        }
    }
}

fn pending_call(message: &RunMessage, block: &Json) -> bool {
    is_call_block(block)
        && !message.results.contains_key(&JsKey::of(block.get("id")))
        && (message.partial || str_eq(message.msg.get("stopReason"), "toolUse"))
}

fn presentation_of<'a>(tool_presentations: &'a Json, tool_name: Option<&U16String>) -> Option<&'a Json> {
    match tool_name {
        Some(name) => tool_presentations.get_units(name.units()),
        None => tool_presentations.get(""),
    }
}

/// The codemode tool's only argument is a `code` envelope; the detail pane is
/// more useful showing the script itself than escaped JSON.
fn args_text_of(args: Option<&Json>, tool_name: Option<&U16String>) -> Option<String> {
    let args = args?;
    if tool_name.is_some_and(|n| n.units() == lit("codemode")) && args.is_container() {
        if let Some(code) = args.get("code").and_then(Json::as_str) {
            return Some(code.to_string_lossy());
        }
    }
    Some(args.to_json())
}

fn child_conversation_id(details: Option<&Json>) -> Option<u64> {
    // `typeof details === "object"` admits arrays; their reads simply miss.
    // A non-integer or negative conversationId degrades to absent.
    crate::json::num_key(details.filter(|d| d.is_container())?.get("conversationId"))
}

fn codemode_child(call: &Json, tool_presentations: &Json) -> ToolItem {
    let status = call.get("status");
    let state = if str_eq(status, "ok") {
        ToolPartState::OutputAvailable
    } else {
        // Stored details are written once, when the card settles: a call
        // still "running" then was cancelled, never still in flight.
        ToolPartState::OutputError
    };
    let output = if str_eq(status, "error") {
        call.get("error").map(|e| U16String::js_string(e).to_string_lossy())
    } else if state == ToolPartState::OutputError {
        Some("Cancelled".to_string())
    } else {
        None
    };
    let name = call.get("name").and_then(Json::as_str);
    let classified = call.get("details").map(|d| classify(presentation_of(tool_presentations, name), d));
    let pinomad = match &classified {
        Some(ClassifiedDoc::Diff(value)) => {
            Some(PinomadToolDetail::Diff { patch: value.patch.clone() })
        }
        _ => None,
    };
    ToolItem {
        state,
        tool_call_id: None,
        tool_name: name.map(|n| n.to_string_lossy()),
        args_text: call.get("args").and_then(Json::as_str).map(|a| a.to_string_lossy()),
        output,
        duration_ms: call.get("durationMs").and_then(Json::as_number),
        diff_stat: None,
        images: Vec::new(),
        children: Vec::new(),
        pinomad,
    }
}

/// A live nested call from `pi.live.nestedTools`, as a codemode card child.
fn nested_child(slot: &Json) -> ToolItem {
    let summary = slot.get("summary");
    let done = str_eq(slot.get("status"), "done");
    let state = if !done {
        ToolPartState::InputAvailable
    } else if summary.is_none() || summary.and_then(|s| s.get("isError")).is_some_and(|e| e.truthy()) {
        // A done slot without a summary faulted or was orphaned.
        ToolPartState::OutputError
    } else {
        ToolPartState::OutputAvailable
    };
    ToolItem {
        state,
        tool_call_id: slot.get("callId").map(|v| U16String::js_string(v).to_string_lossy()),
        tool_name: slot.get("name").and_then(Json::as_str).map(|n| n.to_string_lossy()),
        args_text: slot.get("arguments").map(|a| a.to_json()),
        output: summary
            .and_then(|s| s.get("error"))
            .and_then(Json::as_str)
            .map(|e| e.to_string_lossy()),
        duration_ms: summary.and_then(|s| s.get("durationMs")).and_then(Json::as_number),
        diff_stat: None,
        images: Vec::new(),
        children: Vec::new(),
        pinomad: None,
    }
}

fn tool_item(
    block: &Json,
    message: &RunMessage,
    live_slots: &HashMap<JsKey, &Json>,
    nested_by_parent: &HashMap<JsKey, Vec<&Json>>,
    tool_presentations: &Json,
) -> ToolItem {
    let call_id = block.get("id").expect("call block carries id");
    let key = JsKey::of(Some(call_id));
    let result = message.results.get(&key).copied();
    let slot = if message.partial { None } else { live_slots.get(&key).copied() };
    // `slot?.name ?? block.name`: the fallback keeps the raw block name —
    // a null there is a null toolName, which reads as undefined below.
    let tool_name_raw = not_null(slot.and_then(|s| s.get("name"))).or_else(|| block.get("name"));
    let tool_name = tool_name_raw.and_then(Json::as_str);
    let args_text = args_text_of(block.get("arguments"), tool_name);

    let (state, output);
    if let Some(result) = result {
        state = if matches!(result.get("isError"), Some(Json::Bool(true))) {
            ToolPartState::OutputError
        } else {
            ToolPartState::OutputAvailable
        };
        output = Some(lossy(&text_of(result.get("content"))));
    } else if slot.is_some_and(|s| str_eq(s.get("status"), "running")) {
        state = ToolPartState::InputAvailable;
        output = slot.and_then(|s| s.get("output")).and_then(Json::as_str).map(|o| o.to_string_lossy());
    } else if message.partial {
        state = ToolPartState::InputStreaming;
        output = None;
    } else if !str_eq(message.msg.get("stopReason"), "toolUse") {
        // Only a tool-calling answer runs its calls; an aborted, failed, or
        // truncated one never does.
        state = ToolPartState::OutputError;
        output = Some("Not run: the answer was interrupted.".to_string());
    } else {
        state = ToolPartState::InputAvailable;
        output = slot.and_then(|s| s.get("output")).and_then(Json::as_str).map(|o| o.to_string_lossy());
    }

    let details = not_null(result.and_then(|r| r.get("details"))).or_else(|| not_null(slot.and_then(|s| s.get("details"))));
    let classified = details.map(|d| classify(presentation_of(tool_presentations, tool_name), d));
    let diff_stat: Option<DiffStat> = match result {
        Some(result) if !matches!(result.get("isError"), Some(Json::Bool(true))) => {
            stat_from_details(result.get("details"))
        }
        _ => None,
    };
    let images = result.map(|r| images_of(r.get("content"))).unwrap_or_default();
    let child = child_conversation_id(details);

    let mut pinomad = None;
    let mut children = Vec::new();
    if let Some(ClassifiedDoc::Diff(value)) = &classified {
        pinomad = Some(PinomadToolDetail::Diff { patch: value.patch.clone() });
    } else if let Some(child) = child {
        pinomad = Some(PinomadToolDetail::Subagent {
            conversation_id: child,
            output: output.clone(),
            model: details.and_then(|d| d.get("model")).and_then(Json::as_str).map(|m| m.to_string_lossy()),
            started_at: details.and_then(|d| d.get("startedAt")).and_then(Json::as_number),
            ended_at: result.and_then(|r| r.get("timestamp")).and_then(Json::as_number),
        });
    }
    if tool_name.is_some_and(|n| n.units() == lit("codemode")) && result.is_none() {
        // Upstream writes details.calls once, with the result; while the
        // script runs, its nested calls show live from pi.live.nestedTools.
        children = nested_by_parent
            .get(&key)
            .map(|slots| slots.iter().map(|slot| nested_child(slot)).collect())
            .unwrap_or_default();
    } else if let Some(ClassifiedDoc::Codemode(value)) = &classified {
        let doc = value.to_json();
        children = doc
            .get("calls")
            .and_then(Json::as_array)
            .map(|calls| calls.iter().map(|call| codemode_child(call, tool_presentations)).collect())
            .unwrap_or_default();
    }

    ToolItem {
        state,
        tool_call_id: Some(string_of_value(Some(call_id)).unwrap_or_default()),
        tool_name: tool_name.map(|n| n.to_string_lossy()),
        args_text,
        output,
        diff_stat,
        images,
        children,
        pinomad,
        duration_ms: None,
    }
}

/// Consecutive tool calls in one message are one step.
enum MessageSlot<'a> {
    Thinking { block: &'a Json, index: usize },
    Tools { blocks: Vec<&'a Json> },
    Text { block: &'a Json },
}

fn slots_of(content: &[Json]) -> Vec<MessageSlot<'_>> {
    let mut slots: Vec<MessageSlot> = Vec::new();
    for (index, block) in content.iter().enumerate() {
        if is_call_block(block) {
            match slots.last_mut() {
                Some(MessageSlot::Tools { blocks }) => blocks.push(block),
                _ => slots.push(MessageSlot::Tools { blocks: vec![block] }),
            }
        } else if str_eq(block.get("type"), "thinking") {
            slots.push(MessageSlot::Thinking { block, index });
        } else if str_eq(block.get("type"), "text") {
            slots.push(MessageSlot::Text { block });
        }
    }
    slots
}

/// `wroteTodo` — whether a codemode script's nested calls include a
/// successful `todo_write`. The nested call has no time of its own; the
/// script's result bounds it, and the script failing afterwards does not undo
/// the write.
fn wrote_todo(details: Option<&Json>) -> bool {
    details
        .and_then(|d| d.get("calls"))
        .and_then(Json::as_array)
        .is_some_and(|calls| {
            calls
                .iter()
                .any(|nested| str_eq(nested.get("name"), "todo_write") && str_eq(nested.get("status"), "ok"))
        })
}

fn derive_run(
    id: String,
    draft: &RunDraft,
    live: &Json,
    busy: bool,
    tool_presentations: &Json,
) -> ChatEntry {
    let live_slots: HashMap<JsKey, &Json> = if busy {
        live.get("tools")
            .and_then(Json::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|slot| Some((JsKey::of(slot.get("callId")), slot)))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    // Nested calls of running tools, grouped by the parent call's id; `pi.*`
    // internals (codemode's own plumbing) stay off the card.
    let mut nested_by_parent: HashMap<JsKey, Vec<&Json>> = HashMap::new();
    if busy {
        if let Some(nested) = live.get("nestedTools").and_then(Json::as_array) {
            for slot in nested.iter() {
                let skip = slot
                    .get("name")
                    .and_then(Json::as_str)
                    .is_some_and(|n| text::starts_with(n.units(), &lit("pi.")));
                if skip {
                    continue;
                }
                nested_by_parent
                    .entry(JsKey::of(slot.get("parentCallId")))
                    .or_default()
                    .push(slot);
            }
        }
    }
    let partial = if busy {
        live.get("generation").and_then(|g| g.get("message"))
    } else {
        None
    };
    let mut messages: Vec<RunMessage> = draft
        .assistants
        .iter()
        .map(|a| RunMessage {
            id: a.id.clone(),
            msg: a.msg,
            partial: false,
            results: a.results.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        })
        .collect();
    if let Some(partial_msg) = partial {
        messages.push(RunMessage {
            id: "live".to_string(),
            msg: partial_msg,
            partial: true,
            results: HashMap::new(),
        });
    }
    let latest = messages.last();
    let last_committed = draft.assistants.last();

    let settled = !busy;
    let latest_blocks: &[Json] = latest
        .and_then(|m| m.msg.get("content"))
        .and_then(Json::as_array)
        .map(|c| c.as_slice())
        .unwrap_or(&[]);
    let answer_text: Vec<u16> = latest_blocks
        .iter()
        .filter(|b| str_eq(b.get("type"), "text"))
        .flat_map(|b| not_null(b.get("text")).map(|t| U16String::js_string(t).0).unwrap_or_default())
        .collect();
    let latest_has_calls = latest_blocks.iter().any(is_call_block);
    // While the run is live, a message that holds a tool call cannot be
    // answering — its text is interim output.
    let answering = !answer_text.is_empty() && (settled || !latest_has_calls);

    // A call still owed an execution keeps the phase on acting. Calls inside
    // a non-toolUse answer never ran (they carry the interrupted error).
    let unexecuted_tool = messages
        .iter()
        .any(|message| {
            message
                .msg
                .get("content")
                .and_then(Json::as_array)
                .is_some_and(|content| content.iter().any(|block| pending_call(message, block)))
        });
    let latest_part = latest_blocks.last();

    let phase = if settled {
        CotPhase::Settled
    } else if answering {
        CotPhase::Answering
    } else if unexecuted_tool || latest_part.is_some_and(|p| is_call_block(p)) {
        CotPhase::Acting
    } else if !messages.is_empty() {
        CotPhase::Thinking
    } else {
        CotPhase::Hidden
    };

    let ticking = matches!(phase, CotPhase::Thinking | CotPhase::Acting);
    let mut steps: Vec<CotStep> = Vec::new();

    for (message_index, message) in messages.iter().enumerate() {
        let is_latest = message_index == messages.len() - 1;
        let content = message
            .msg
            .get("content")
            .and_then(Json::as_array)
            .map(|c| c.as_slice())
            .unwrap_or(&[]);
        for (slot_index, slot) in slots_of(content).into_iter().enumerate() {
            match slot {
                MessageSlot::Tools { blocks } => {
                    let pending: Vec<&Json> = blocks
                        .iter()
                        .filter(|block| pending_call(message, block))
                        .copied()
                        .collect();
                    let step_live = ticking && !pending.is_empty();
                    steps.push(CotStep::Tools {
                        id: format!("{}-tools-{}", message.id, slot_index),
                        tools: blocks
                            .iter()
                            .map(|block| tool_item(block, message, &live_slots, &nested_by_parent, tool_presentations))
                            .collect(),
                        live: step_live,
                        // The agent executes in order, so the active call is
                        // the first unexecuted one.
                        active_tool_call_id: if step_live {
                            pending
                                .first()
                                .and_then(|b| b.get("id"))
                                .map(|v| U16String::js_string(v).to_string_lossy())
                        } else {
                            None
                        },
                    });
                }
                MessageSlot::Text { block } => {
                    if !(is_latest && answering) {
                        steps.push(CotStep::Interim {
                            id: format!("{}-text-{}", message.id, slot_index),
                            text: not_null(block.get("text"))
                                .map(|t| U16String::js_string(t).to_string_lossy())
                                .unwrap_or_default(),
                        });
                    }
                }
                MessageSlot::Thinking { block, index } => {
                    // A thinking block is live only while it is the streaming
                    // partial's tail block — a later block means it finished.
                    steps.push(CotStep::Thinking {
                        id: format!("{}-thinking-{}", message.id, slot_index),
                        text: not_null(block.get("thinking"))
                            .map(|t| U16String::js_string(t).to_string_lossy())
                            .unwrap_or_default(),
                        live: ticking && message.partial && index == content.len() - 1,
                    });
                }
            }
        }
    }

    let mut todo_written_at_ms: Option<f64> = None;
    for message in &messages {
        let content = message.msg.get("content").and_then(Json::as_array);
        for block in content.into_iter().flat_map(|c| c.iter()) {
            if !is_call_block(block) {
                continue;
            }
            let Some(written) = message.results.get(&JsKey::of(block.get("id"))) else {
                continue;
            };
            let Some(ts) = written.get("timestamp").and_then(Json::as_number) else {
                continue;
            };
            let wrote = if str_eq(block.get("name"), "todo_write") {
                !matches!(written.get("isError"), Some(Json::Bool(true)))
            } else {
                str_eq(block.get("name"), "codemode") && wrote_todo(written.get("details"))
            };
            if wrote {
                todo_written_at_ms = Some(ts);
            }
        }
    }

    let interrupted = last_committed.is_some_and(|a| str_eq(a.msg.get("stopReason"), "aborted"));
    let failed = settled && last_committed.is_some_and(|a| str_eq(a.msg.get("stopReason"), "error"));
    let anchor_ms = messages
        .first()
        .and_then(|m| m.msg.get("timestamp"))
        .map(|v| v.as_number().unwrap_or(f64::NAN));
    let elapsed_ms = if settled && anchor_ms.is_some() {
        let end = if answering {
            latest.and_then(|m| m.msg.get("timestamp")).map(|v| v.as_number().unwrap_or(f64::NAN))
        } else {
            draft
                .last_ts
                .or_else(|| latest.and_then(|m| m.msg.get("timestamp")).map(|v| v.as_number().unwrap_or(f64::NAN)))
        };
        end.map(|end| end - anchor_ms.unwrap_or(f64::NAN))
    } else {
        None
    };

    ChatEntry::Run {
        id,
        cot: CotView {
            phase,
            failed,
            anchor_ms,
            elapsed_ms,
            todo_written_at_ms,
            steps,
            answer: if answering {
                Some(CotAnswer {
                    text: lossy(&answer_text),
                    streaming: latest.is_some_and(|m| m.partial),
                })
            } else {
                None
            },
        },
        interrupted,
        fork_entry_id: if settled && !interrupted && !failed {
            last_committed.map(|a| a.id.clone())
        } else {
            None
        },
        failure: if failed {
            Some(
                not_null(last_committed.and_then(|a| a.msg.get("errorMessage")))
                    .map(|e| U16String::js_string(e).to_string_lossy())
                    .unwrap_or_else(|| "The run failed.".to_string()),
            )
        } else {
            None
        },
    }
}

/// `deriveChat(view, toolPresentations, busy)` — the conversation's entries
/// grouped into user/run/compaction/reset rows, the tail group becoming the
/// live run while busy.
pub fn derive_chat(view: &Json, tool_presentations: &Json, busy: bool) -> Vec<ChatEntry> {
    let mut items: Vec<ChatEntry> = Vec::new();
    let empty_live = Json::object();
    let live = not_null(view.get("docs").and_then(|docs| docs.get("pi.live"))).unwrap_or(&empty_live);
    let mut draft: Option<RunDraft> = None;
    let mut run_seq = 0usize;

    macro_rules! flush {
        ($busy_run:expr) => {
            if let Some(d) = draft.take() {
                if !d.assistants.is_empty() || !d.orphans.is_empty() || $busy_run {
                    let anchor = d
                        .assistants
                        .first()
                        .map(|a| a.id.clone())
                        .unwrap_or_else(|| {
                            let id = format!("open-{}", run_seq);
                            run_seq += 1;
                            id
                        });
                    items.push(derive_run(format!("run-{anchor}"), &d, live, $busy_run, tool_presentations));
                }
            }
        };
    }

    let entries: &[Json] = view
        .get("entries")
        .and_then(Json::as_array)
        .map(|e| e.as_slice())
        .unwrap_or(&[]);
    for entry in entries {
        let message = entry.get("model").and_then(Json::as_array).and_then(|m| m.first());
        let id = lossy(&text::string_of(entry.get("id")));
        let kind = entry.get("kind");
        if str_eq(kind, "pi.user") && str_eq(message.and_then(|m| m.get("role")), "user") {
            flush!(false);
            items.push(ChatEntry::User {
                id,
                text: lossy(&text_of(message.and_then(|m| m.get("content")))),
                images: images_of(message.and_then(|m| m.get("content"))),
            });
        } else if str_eq(kind, "pi.compaction") {
            flush!(false);
            items.push(ChatEntry::Compaction { id });
        } else if str_eq(kind, "pi.reset") {
            flush!(false);
            items.push(ChatEntry::Reset { id });
        } else if str_eq(kind, "pi.assistant") && str_eq(message.and_then(|m| m.get("role")), "assistant") {
            let message = message.expect("role check passed");
            let draft = draft.get_or_insert_with(RunDraft::new);
            // A result can outrun its call in the log; the new call claims it.
            let mut results: HashMap<JsKey, &Json> = HashMap::new();
            if let Some(content) = message.get("content").and_then(Json::as_array) {
                for block in content.iter() {
                    if !is_call_block(block) {
                        continue;
                    }
                    let key = JsKey::of(block.get("id"));
                    if let Some(orphan) = draft.orphans.remove(&key) {
                        results.insert(key, orphan);
                    }
                }
            }
            draft.assistants.push(AssistantEntry { id, msg: message, results });
            draft.note_timestamp(message);
        } else if str_eq(kind, "pi.tool-result")
            && str_eq(message.and_then(|m| m.get("role")), "toolResult")
            && message.is_some_and(|m| m.get("toolCallId").is_some())
        {
            let message = message.expect("role check passed");
            let draft = draft.get_or_insert_with(RunDraft::new);
            let key = JsKey::of(message.get("toolCallId"));
            // Call ids repeat across rounds: the newest unclaimed call owns it.
            let target = draft.assistants.iter_mut().rev().find(|assistant| {
                !assistant.results.contains_key(&key)
                    && assistant
                        .msg
                        .get("content")
                        .and_then(Json::as_array)
                        .is_some_and(|content| {
                            content
                                .iter()
                                .any(|block| is_call_block(block) && js_strict_eq(block.get("id").unwrap(), message.get("toolCallId").unwrap()))
                        })
            });
            match target {
                None => {
                    draft.orphans.insert(key, message);
                }
                Some(target) => {
                    target.results.insert(key, message);
                }
            }
            draft.note_timestamp(message);
        }
    }

    // The tail group is the live run while the conversation is busy; an empty
    // one still renders (the run exists even before its first message).
    if busy && draft.is_none() {
        draft = Some(RunDraft::new());
    }
    flush!(busy);
    items
}

/// The tail failure's retry: the user text the failed run answered, keyed to
/// that run so repeated retries admit once.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct RetryRequest {
    pub text: String,
    pub images: Vec<MessageImage>,
    pub request_id: String,
}

/// `retryOf(entries)` — undefined when the newest entry is not a failed run,
/// or no user text/images precede it.
pub fn retry_of(entries: &[ChatEntry]) -> Option<RetryRequest> {
    let last = entries.last()?;
    let ChatEntry::Run { id: run_id, failure, .. } = last else { return None };
    failure.as_ref()?;
    for entry in entries[..entries.len() - 1].iter().rev() {
        match entry {
            // A compaction between the prompt and the run doesn't break the
            // reach back; a reset or another run does.
            ChatEntry::Compaction { .. } => continue,
            ChatEntry::User { text, images, .. } if !(text::is_blank_str(text) && images.is_empty()) => {
                // The run id is stable across views, so a second click or
                // another client's retry dedupes on the host.
                return Some(RetryRequest {
                    text: text.clone(),
                    images: images.clone(),
                    request_id: format!("retry:{run_id}"),
                });
            }
            _ => return None,
        }
    }
    None
}

/// One lifted subagent call and the key the UI anchors its card to.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct LiftedSubagent {
    pub key: String,
    pub tool: ToolItem,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct SplitSubagents {
    pub view: CotView,
    pub subagents: Vec<LiftedSubagent>,
}

/// `splitSubagentCalls(view)` — lift subagent calls out of a run's steps for
/// the anchor cards: identified by tool name (a still-streaming call has no
/// details yet), order preserved, emptied tools steps dropped.
pub fn split_subagent_calls(view: &CotView) -> SplitSubagents {
    let mut subagents = Vec::new();
    let mut steps = Vec::new();
    for step in &view.steps {
        let CotStep::Tools { id, tools, live, active_tool_call_id } = step else {
            steps.push(step.clone());
            continue;
        };
        let mut rest = Vec::new();
        for (index, tool) in tools.iter().enumerate() {
            if tool.tool_name.as_deref() != Some("subagent") {
                rest.push(tool.clone());
                continue;
            }
            // Call ids only have to be unique within one message — providers
            // reuse them — so the key scopes each card to its step.
            let key = format!("{id}/{}", tool.tool_call_id.clone().unwrap_or_else(|| index.to_string()));
            subagents.push(LiftedSubagent { key, tool: tool.clone() });
        }
        if rest.is_empty() {
            continue;
        }
        if active_tool_call_id.is_some()
            && !rest.iter().any(|tool| tool.tool_call_id.is_some() && tool.tool_call_id == *active_tool_call_id)
        {
            let next = rest
                .iter()
                .find(|tool| matches!(tool.state, ToolPartState::InputStreaming | ToolPartState::InputAvailable))
                .map(|tool| tool.tool_call_id.clone());
            match next {
                // Nothing is still in flight: the row must not keep showing
                // a stale call.
                None => steps.push(CotStep::Tools {
                    id: id.clone(),
                    tools: rest,
                    live: false,
                    active_tool_call_id: None,
                }),
                Some(next_id) => steps.push(CotStep::Tools {
                    id: id.clone(),
                    tools: rest,
                    live: *live,
                    // `nextActive.toolCallId === undefined ? {} : {activeToolCallId}` —
                    // a pending call without an id keeps the previous value.
                    active_tool_call_id: next_id.or_else(|| active_tool_call_id.clone()),
                }),
            }
        } else {
            steps.push(CotStep::Tools {
                id: id.clone(),
                tools: rest,
                live: *live,
                active_tool_call_id: active_tool_call_id.clone(),
            });
        }
    }
    SplitSubagents {
        view: CotView { steps, ..view.clone() },
        subagents,
    }
}
