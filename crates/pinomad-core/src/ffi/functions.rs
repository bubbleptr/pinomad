// The stateless derivations the UI calls directly, exported as free
// functions with typed inputs. Where the core implementation reads Json,
// the delivery record rebuilds the wire object it came from — the
// derivation itself is not duplicated here.

use crate::ffi::hosts::StoredHost;
use crate::ffi::types::*;
use crate::json::Json;

#[uniffi::export]
pub fn relative_time(at: f64, now: f64) -> String {
    crate::family::relative_time(at, now)
}

#[uniffi::export]
pub fn folder_crumbs(path: String, home: String) -> Vec<FolderCrumb> {
    crate::folder_path::folder_crumbs(&path, &home)
}

/// The folder one level up, or `None` at "/".
#[uniffi::export]
pub fn parent_folder(path: String) -> Option<String> {
    crate::folder_path::parent_folder(&path)
}

/// The tail failure's retry — `None` when the newest entry is not a failed
/// run, or no user text/images precede it.
#[uniffi::export]
pub fn retry_of(entries: Vec<ChatEntry>) -> Option<RetryRequest> {
    crate::cot_view::retry_of(&entries)
}

/// Lift subagent calls out of a run's steps for the anchor cards.
#[uniffi::export]
pub fn split_subagent_calls(view: CotView) -> SplitSubagents {
    crate::cot_view::split_subagent_calls(&view)
}

#[uniffi::export]
pub fn tool_display_name(name: Option<String>) -> Option<String> {
    crate::tool_item::tool_display_name(name.as_deref())
}

/// Parse the args text and pull the target key.
#[uniffi::export]
pub fn tool_target_from_args(args_text: Option<String>) -> Option<String> {
    crate::tool_item::tool_target_from_args(args_text.as_deref())
}

/// `Nms` under a second, else `N.Ns`.
#[uniffi::export]
pub fn format_tool_duration(duration_ms: Option<f64>) -> Option<String> {
    crate::tool_item::format_tool_duration(duration_ms)
}

#[uniffi::export]
pub fn tool_kind_from_name(name: Option<String>) -> ToolKind {
    crate::tool_item::tool_kind_from_name(name.as_deref())
}

/// A burst of mixed kinds shares the generic wrench.
#[uniffi::export]
pub fn tool_kind_from_tools(tools: Vec<ToolItem>) -> ToolKind {
    crate::tool_item::tool_kind_from_tools(&tools)
}

/// The `pinomad` payload a tool item may carry (diff patch or subagent
/// card data).
#[uniffi::export]
pub fn pinomad_of(tool: ToolItem) -> Option<PinomadToolDetail> {
    crate::tool_item::pinomad_of(&tool)
}

fn models_json(models: &[ModelSummary]) -> Vec<Json> {
    models.iter().map(ModelSummary::to_json).collect()
}

/// Case-insensitive substring match on the display name or provider/modelId.
#[uniffi::export]
pub fn filter_models(models: Vec<ModelSummary>, query: String) -> Vec<ModelSummary> {
    crate::model::filter_models(&models_json(&models), &query)
        .into_iter()
        .map(ModelSummary::from_core)
        .collect()
}

/// The first listed model matching the ref exactly.
#[uniffi::export]
pub fn summary_of(models: Vec<ModelSummary>, model: Option<ModelRef>) -> Option<ModelSummary> {
    crate::model::summary_of(&models_json(&models), model).map(ModelSummary::from_core)
}

/// "Name · Level" when the model reasons, else just the name.
#[uniffi::export]
pub fn model_label(models: Vec<ModelSummary>, selected: ModelPick) -> String {
    crate::model::model_label(&models_json(&models), selected)
}

/// Remembered if still listed → the host default → the first model → none;
/// the level clamps to the resolved model.
#[uniffi::export]
pub fn reconcile_draft_pick(
    models: Vec<ModelSummary>,
    defaults: Option<Defaults>,
    remembered: ModelPick,
) -> ModelPick {
    let defaults_json = defaults.map(|d| {
        let mut object = crate::json::JsonObject::new();
        if let Some(model) = d.model {
            object.set(crate::u16str::U16String::from_str("model"), model.to_json());
        }
        if let Some(level) = d.thinking_level {
            object.set(
                crate::u16str::U16String::from_str("thinkingLevel"),
                Json::from(level.as_str()),
            );
        }
        Json::Object(std::sync::Arc::new(object))
    });
    crate::model::reconcile_draft_pick(&models_json(&models), defaults_json.as_ref(), remembered)
}

/// Keep `want` when supported, else the highest supported level not above
/// it, else "off".
#[uniffi::export]
pub fn clamp_level(levels: Vec<ThinkingLevel>, want: ThinkingLevel) -> ThinkingLevel {
    crate::model::clamp_level(&levels, &want)
}

#[uniffi::export]
pub fn thinking_level_label(level: ThinkingLevel) -> Option<String> {
    crate::model::thinking_level_label(&level)
}

/// Strict provider + modelId equality; `None` never matches.
#[uniffi::export]
pub fn same_model(a: Option<ModelRef>, b: Option<ModelRef>) -> bool {
    crate::model::same_model(a, b)
}

/// What a conversation is called wherever the UI names it.
#[uniffi::export]
pub fn display_name(summary: Option<ConversationSummary>) -> String {
    let raw = summary.map(|s| s.to_json());
    crate::family::display_name(raw.as_ref())
}

/// The most urgent status among the root and all of its descendants.
#[uniffi::export]
pub fn family_status(node: ConversationNode) -> Option<ConversationStatus> {
    crate::family::family_status(&node.to_core())
}

/// The freshest `updatedAt` among the root and all of its descendants.
#[uniffi::export]
pub fn family_updated_at(node: ConversationNode) -> Option<f64> {
    crate::family::family_updated_at(&node.to_core())
}

/// The organized node for a conversation id, wherever it nests.
#[uniffi::export]
pub fn find_conversation(organized: Organized, id: u64) -> Option<ConversationNode> {
    crate::organization::find_conversation(&organized.to_core(), id).map(ConversationNode::from_core)
}

/// The top-level node a conversation belongs to — `parent` links walked to
/// the root.
#[uniffi::export]
pub fn root_of(organized: Organized, id: u64) -> Option<ConversationNode> {
    crate::family::root_of(&organized.to_core(), id).map(ConversationNode::from_core)
}

/// The family's forks, depth-first.
#[uniffi::export]
pub fn threads_of(root: ConversationNode) -> Vec<ConversationNode> {
    crate::family::threads_of(&root.to_core())
        .into_iter()
        .map(ConversationNode::from_core)
        .collect()
}

/// The family's subagents grouped by owner — the root first, then each
/// fork that has any.
#[uniffi::export]
pub fn task_groups_of(root: ConversationNode) -> Vec<TaskGroup> {
    crate::family::task_groups_of(&root.to_core())
        .into_iter()
        .map(|group| TaskGroup {
            owner: ConversationSummary::from_core(group.owner),
            label: group.label,
            tasks: group.tasks.into_iter().map(ConversationNode::from_core).collect(),
        })
        .collect()
}

/// The forks anchored at one of a conversation's entries — the "N forks"
/// chip's targets.
#[uniffi::export]
pub fn forks_at(organized: Organized, conversation_id: u64, entry_id: String) -> Vec<u64> {
    crate::family::forks_at(&organized.to_core(), conversation_id, &entry_id)
}

/// Sidebar/menu label per host — the URL's host, disambiguated by the
/// hostKey prefix when two hosts share one.
#[uniffi::export]
pub fn host_labels(hosts: Vec<StoredHost>) -> Vec<HostLabel> {
    let cores: Vec<crate::stored_host::StoredHost> = hosts
        .iter()
        .map(|host| crate::stored_host::StoredHost {
            url: host.url.clone(),
            host_key: host.host_key.clone(),
            private_key: host.private_key.clone(),
            // `hostLabels` reads only url + hostKey; the account linkage is
            // irrelevant here.
            account: None,
        })
        .collect();
    crate::stored_host::host_labels(&cores)
}

/// One `QuestionAnswer` per question; untouched questions count as skipped
/// (blank `other`s are omitted).
#[uniffi::export]
pub fn question_answers(
    question_count: u64,
    selections: Vec<Vec<String>>,
    others: Vec<String>,
) -> Vec<QuestionAnswer> {
    crate::questions::question_answers(question_count as usize, &selections, &others)
}

/// How many images one message may carry — sizes the client's picker so
/// it never offers more than `image_problem` would admit.
#[uniffi::export]
pub fn max_images_per_message() -> u32 {
    crate::images::MAX_IMAGES_PER_MESSAGE
}

/// Why a message's images can't be admitted, or `None` when they can —
/// the host enforces the verdict, the client may pre-check.
#[uniffi::export]
pub fn image_problem(images: Vec<MessageImage>) -> Option<String> {
    let list = Json::array(
        images
            .iter()
            .map(|image| {
                let mut object = crate::json::JsonObject::new();
                object.set(
                    crate::u16str::U16String::from_str("data"),
                    Json::from(image.data.clone()),
                );
                object.set(
                    crate::u16str::U16String::from_str("mimeType"),
                    Json::from(image.mime_type.clone()),
                );
                Json::Object(std::sync::Arc::new(object))
            })
            .collect(),
    );
    crate::images::image_problem(&list)
}
