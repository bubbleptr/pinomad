// Replays the generated comparison vectors (ADR-0024 §6) from
// packages/client/test/fixtures/rust-vectors/ — the TS reference computed
// the expectations; regenerate with PINOMAD_UPDATE_VECTORS=1.

use std::path::PathBuf;

use pinomad_core::chat::{agent_of, queue_items, status_text, task_rows, usage_rows};
use pinomad_core::cot_view::{derive_chat, retry_of, split_subagent_calls};
use pinomad_core::json::Json;
use pinomad_core::presentation::classify;
use pinomad_core::tool_diff_stat::tool_diff_stat_from_result;
use pinomad_core::tool_item::{
    format_tool_duration, normalize_tool_name, tool_display_name, tool_kind_from_name,
    tool_kind_from_tools, tool_target_from_args,
};
use pinomad_core::tool_target::tool_target;
use pinomad_core::transcript::is_busy;
use pinomad_core::u16str::U16String;

mod derive_vectors {
    pub mod input;
    pub mod out;
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/client/test/fixtures/rust-vectors")
}

fn load(name: &str) -> Json {
    let text = std::fs::read_to_string(fixtures().join(format!("{name}.json")))
        .unwrap_or_else(|error| panic!("fixture {name}.json: {error}"));
    Json::parse(&text).unwrap_or_else(|error| panic!("fixture {name}.json parses: {error}"))
}

fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    value.get(key).expect(&format!("field {key} on {value:?}"))
}

fn as_text(value: &Json) -> String {
    value.as_str().expect("string").to_string_lossy()
}

fn cases<'a>(file: &'a Json, section: &str) -> &'a [Json] {
    field(file, section).as_array().expect("cases array")
}

/// An `expect` field that carries `null` for a missing result.
fn expect_text(case: &Json) -> String {
    as_text(field(case, "expect"))
}

/// The same lone-surrogate normalization the generator applies to expected
/// values: `\uXXXX` escapes for unpaired surrogates read back as U+FFFD, so a
/// Rust value that kept the raw surrogate compares equal to a lossy one.
fn norm(value: &Json) -> String {
    let wire = value.to_json();
    let chars: Vec<char> = wire.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\\' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut run = 0;
        while i + run < chars.len() && chars[i + run] == '\\' {
            run += 1;
        }
        let hex: String = if run % 2 == 1 && chars.get(i + run) == Some(&'u') {
            chars[i + run + 1..(i + run + 5).min(chars.len())].iter().collect()
        } else {
            String::new()
        };
        let code = u32::from_str_radix(&hex, 16).unwrap_or(0);
        if hex.len() == 4 && (0xd800..=0xdfff).contains(&code) {
            out.extend(std::iter::repeat('\\').take(run - 1));
            out.push('\u{FFFD}');
            i += run + 5;
        } else {
            out.extend(std::iter::repeat('\\').take(run));
            i += run;
        }
    }
    out
}

/// A wire-encoded field: the field's string is itself JSON text ("null" for
/// an input that was undefined).
fn wire_field(case: &Json, key: &str) -> Option<Json> {
    case.get(key)
        .and_then(Json::as_str)
        .map(|text| Json::parse(&text.to_string_lossy()).unwrap())
}

fn opt_json(json: Option<Json>) -> Json {
    json.unwrap_or(Json::Null)
}

#[test]
fn derive_chat_replays() {
    let file = load("chat");
    for case in cases(&file, "deriveChat") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        let busy = field(case, "busy").truthy();
        let presentations = Json::parse(&as_text(field(case, "presentations"))).unwrap();
        let entries = derive_chat(&view, &presentations, busy);
        assert_eq!(
norm(&derive_vectors::out::chat_entries_json(&entries)),
expect_text(case),
            "{name}"
        );
    }
}

#[test]
fn retry_of_replays() {
    let file = load("chat");
    for case in cases(&file, "retryOf") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        let busy = field(case, "busy").truthy();
        let presentations = Json::parse(&as_text(field(case, "presentations"))).unwrap();
        let entries = derive_chat(&view, &presentations, busy);
        assert_eq!(
norm(&derive_vectors::out::retry_json(retry_of(&entries).as_ref())),
expect_text(case),
            "{name}"
        );
    }
}

#[test]
fn split_subagent_calls_replays() {
    let file = load("chat");
    for case in cases(&file, "splitSubagentCalls") {
        let name = as_text(field(case, "name"));
        let cot_input = Json::parse(&as_text(field(case, "cot"))).unwrap();
        let cot = derive_vectors::input::cot(&cot_input);
        assert_eq!(
norm(&derive_vectors::out::split_json(&split_subagent_calls(&cot))),
expect_text(case),
            "{name}"
        );
    }
}

#[test]
fn chat_derivations_replay() {
    let file = load("chat-meta");
    for case in cases(&file, "agentOf") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(
norm(&derive_vectors::out::agent_json(&agent_of(&view))),
expect_text(case), "{name}");
    }
    for case in cases(&file, "statusText") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        let got = Json::String(U16String::from_str(&status_text(&view)));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "queueItems") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(
norm(&derive_vectors::out::queue_items_json(&queue_items(&view))),
expect_text(case), "{name}");
    }
    for case in cases(&file, "usageRows") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(
norm(&derive_vectors::out::usage_rows_json(&usage_rows(&view))),
expect_text(case), "{name}");
    }
    for case in cases(&file, "taskRows") {
        let name = as_text(field(case, "name"));
        let graph = Json::parse(&as_text(field(case, "graph"))).unwrap();
        assert_eq!(
norm(&derive_vectors::out::task_rows_json(&task_rows(&graph))),
expect_text(case), "{name}");
    }
    for case in cases(&file, "isBusy") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(
norm(&Json::Bool(is_busy(&view))),
expect_text(case), "{name}");
    }
}

#[test]
fn classify_replays() {
    let file = load("tools");
    for case in cases(&file, "classify") {
        let name = as_text(field(case, "name"));
        let presentation = wire_field(case, "presentation");
        let value = Json::parse(&as_text(field(case, "value"))).unwrap();
        let classified = classify(presentation.as_ref(), &value);
        assert_eq!(
norm(&derive_vectors::out::classified_json(&classified)),
expect_text(case), "{name}");
    }
}

#[test]
fn tool_target_replays() {
    let file = load("tools");
    for case in cases(&file, "toolTarget") {
        let name = as_text(field(case, "name"));
        let args = Json::parse(&as_text(field(case, "args"))).unwrap();
        let got = opt_json(tool_target(&args).map(|t| Json::String(U16String::from_str(&t))));
        assert_eq!(norm(&got), expect_text(case), "{name}");
    }
    for case in cases(&file, "toolTargetFromArgs") {
        let name = as_text(field(case, "name"));
        let args_text = wire_field(case, "argsText").and_then(|v| v.as_str().map(|s| s.to_string_lossy()));
        let got = opt_json(tool_target_from_args(args_text.as_deref()).map(|t| Json::String(U16String::from_str(&t))));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
}

#[test]
fn tool_item_helpers_replay() {
    let file = load("tools");
    for case in cases(&file, "toolDisplayName") {
        let name = as_text(field(case, "name"));
        let input = wire_field(case, "tool").and_then(|v| v.as_str().map(|s| s.to_string_lossy()));
        let got = opt_json(tool_display_name(input.as_deref()).map(|v| Json::String(U16String::from_str(&v))));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "formatToolDuration") {
        let name = as_text(field(case, "name"));
        let input = wire_field(case, "durationMs").and_then(|v| v.as_number());
        let got = opt_json(format_tool_duration(input).map(|v| Json::String(U16String::from_str(&v))));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "toolKindFromName") {
        let name = as_text(field(case, "name"));
        let input = wire_field(case, "tool").and_then(|v| v.as_str().map(|s| s.to_string_lossy()));
        let normalized = Json::String(U16String::from_str(&normalize_tool_name(input.as_deref())));
        assert_eq!(norm(&normalized), as_text(field(case, "normalized")), "{name}: normalized");
        let kind = Json::String(U16String::from_str(tool_kind_from_name(input.as_deref()).as_str()));
        assert_eq!(
norm(&kind),
expect_text(case), "{name}");
    }
    for case in cases(&file, "toolKindFromTools") {
        let name = as_text(field(case, "name"));
        let tools_json = Json::parse(&as_text(field(case, "tools"))).unwrap();
        let tools: Vec<_> = tools_json
            .as_array()
            .expect("tools array")
            .iter()
            .map(derive_vectors::input::tool)
            .collect();
        let kind = Json::String(U16String::from_str(tool_kind_from_tools(&tools).as_str()));
        assert_eq!(
norm(&kind),
expect_text(case), "{name}");
    }
}

// ─── Organization + family ─────────────────────────────────────────────────

fn index_summaries(case: &Json) -> (Json, Vec<Json>) {
    let index = Json::parse(&as_text(field(case, "index"))).unwrap();
    let summaries = Json::parse(&as_text(field(case, "summaries")))
        .unwrap()
        .as_array()
        .expect("summaries array")
        .iter()
        .cloned()
        .collect();
    (index, summaries)
}

#[test]
fn organize_replays() {
    let file = load("organize");
    for case in cases(&file, "organize") {
        let name = as_text(field(case, "name"));
        let (index, summaries) = index_summaries(case);
        let organized = pinomad_core::organization::organize(&index, &summaries)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
norm(&organized.to_json()),
expect_text(case), "{name}");
    }
    for case in cases(&file, "homeOf") {
        let name = as_text(field(case, "name"));
        let (index, summaries) = index_summaries(case);
        let id = field(case, "id").as_number().unwrap() as u64;
        let got = opt_json(pinomad_core::organization::home_of(&index, &summaries, id).map(|h| h.to_json()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "checkoutOf") {
        let name = as_text(field(case, "name"));
        let (index, summaries) = index_summaries(case);
        let id = field(case, "id").as_number().unwrap() as u64;
        let got = opt_json(pinomad_core::organization::checkout_of(&index, &summaries, id).map(|c| c.to_json()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "findConversation") {
        let name = as_text(field(case, "name"));
        let (index, summaries) = index_summaries(case);
        let id = field(case, "id").as_number().unwrap() as u64;
        let organized = pinomad_core::organization::organize(&index, &summaries).unwrap();
        let got = opt_json(pinomad_core::organization::find_conversation(&organized, id).map(|n| n.to_json()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
}

#[test]
fn family_replays() {
    let file = load("family");
    // node cases: organize the input, find the node by id, derive.
    for section in ["familyStatus", "familyUpdatedAt", "threadsOf", "taskGroupsOf"] {
        for case in cases(&file, section) {
            let name = as_text(field(case, "name"));
            let (index, summaries) = index_summaries(case);
            let id = field(case, "id").as_number().unwrap() as u64;
            let organized = pinomad_core::organization::organize(&index, &summaries).unwrap();
            let node = pinomad_core::organization::find_conversation(&organized, id)
                .unwrap_or_else(|| panic!("{name}: node {id}"));
            let got = match section {
                "familyStatus" => opt_json(
                    pinomad_core::family::family_status(&node)
                        .map(|status| Json::String(U16String::from_str(status.as_str()))),
                ),
                "familyUpdatedAt" => opt_json(pinomad_core::family::family_updated_at(&node).map(Json::Number)),
                "threadsOf" => derive_vectors::out::threads_json(&pinomad_core::family::threads_of(&node)),
                _ => derive_vectors::out::task_groups_json(&pinomad_core::family::task_groups_of(&node)),
            };
            assert_eq!(
norm(&got),
expect_text(case), "{section}/{name}");
        }
    }
    for case in cases(&file, "displayName") {
        let name = as_text(field(case, "name"));
        let summary = wire_field(case, "summary");
        let summary = summary.filter(|s| !matches!(s, Json::Null));
        let got = Json::String(U16String::from_str(&pinomad_core::family::display_name(summary.as_ref())));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "relativeTime") {
        let name = as_text(field(case, "name"));
        let at = field(case, "at").as_number().unwrap();
        let now = field(case, "now").as_number().unwrap();
        let got = Json::String(U16String::from_str(&pinomad_core::family::relative_time(at, now)));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "rootOf") {
        let name = as_text(field(case, "name"));
        let (index, summaries) = index_summaries(case);
        let id = field(case, "id").as_number().unwrap() as u64;
        let organized = pinomad_core::organization::organize(&index, &summaries).unwrap();
        let got = opt_json(pinomad_core::family::root_of(&organized, id).map(|n| n.to_json()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "forksAt") {
        let name = as_text(field(case, "name"));
        let (index, summaries) = index_summaries(case);
        let conversation_id = field(case, "conversationId").as_number().unwrap() as u64;
        let entry_id = as_text(field(case, "entryId"));
        let organized = pinomad_core::organization::organize(&index, &summaries).unwrap();
        let ids = pinomad_core::family::forks_at(&organized, conversation_id, &entry_id);
        let got = Json::array(ids.iter().map(|id| Json::Number(*id as f64)).collect());
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
}

// ─── Models ────────────────────────────────────────────────────────────────

#[test]
fn model_replays() {
    let file = load("models");
    assert_eq!(
        derive_vectors::out::level_labels_json().to_json(),
        as_text(field(&file, "thinkingLevelLabels")),
        "thinkingLevelLabels"
    );
    for case in cases(&file, "sameModel") {
        let name = as_text(field(case, "name"));
        let a = wire_field(case, "a").filter(|v| !matches!(v, Json::Null));
        let b = wire_field(case, "b").filter(|v| !matches!(v, Json::Null));
        let a = a.as_ref().and_then(derive_vectors::input::model_ref);
        let b = b.as_ref().and_then(derive_vectors::input::model_ref);
        let got = Json::Bool(pinomad_core::model::same_model(a, b));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "clampLevel") {
        let name = as_text(field(case, "name"));
        let levels: Vec<pinomad_core::model::ThinkingLevel> = Json::parse(&as_text(field(case, "levels")))
            .unwrap()
            .as_array()
            .expect("levels")
            .iter()
            .filter_map(|l| l.as_str().map(|s| pinomad_core::model::ThinkingLevel::from_units(s.units())))
            .collect();
        let want = pinomad_core::model::ThinkingLevel::from_units(
            &as_text(field(case, "want")).encode_utf16().collect::<Vec<u16>>(),
        );
        let got = Json::String(U16String::from_str(pinomad_core::model::clamp_level(&levels, &want).as_str()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "summaryOf") {
        let name = as_text(field(case, "name"));
        let models = Json::parse(&as_text(field(case, "models"))).unwrap();
        let models = models.as_array().expect("models");
        let model_ref = wire_field(case, "ref").and_then(|v| derive_vectors::input::model_ref(&v));
        let got = opt_json(pinomad_core::model::summary_of(models, model_ref).map(|s| s.to_json()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "modelLabel") {
        let name = as_text(field(case, "name"));
        let models = Json::parse(&as_text(field(case, "models"))).unwrap();
        let models = models.as_array().expect("models");
        let selected = derive_vectors::input::model_pick(&Json::parse(&as_text(field(case, "selected"))).unwrap());
        let got = Json::String(U16String::from_str(&pinomad_core::model::model_label(models, selected)));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "filterModels") {
        let name = as_text(field(case, "name"));
        let models = Json::parse(&as_text(field(case, "models"))).unwrap();
        let models = models.as_array().expect("models");
        let Some(query) = field(case, "query")
            .as_str()
            .and_then(|q| String::from_utf16(q.units()).ok())
        else {
            // A query carrying a lone surrogate cannot be a &str — the UI
            // boundary (UniFFI, Swift/Kotlin String) cannot express one either.
            continue;
        };
        let got = Json::array(
            pinomad_core::model::filter_models(models, &query)
                .iter()
                .map(|m| m.to_json())
                .collect(),
        );
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "reconcileDraftPick") {
        let name = as_text(field(case, "name"));
        let models = Json::parse(&as_text(field(case, "models"))).unwrap();
        let models = models.as_array().expect("models");
        let defaults = wire_field(case, "defaults");
        let remembered = derive_vectors::input::model_pick(&Json::parse(&as_text(field(case, "remembered"))).unwrap());
        let pick = pinomad_core::model::reconcile_draft_pick(models, defaults.as_ref(), remembered);
        assert_eq!(
norm(&derive_vectors::out::model_pick_json(&pick)),
expect_text(case), "{name}");
    }
}

// ─── Small standalone derivations ──────────────────────────────────────────

/// The compact `$repeat` marker used for multi-MB image data.
fn image_images(case: &Json) -> Json {
    let parsed = Json::parse(&as_text(field(case, "images"))).unwrap();
    let Some(list) = parsed.as_array() else { return parsed };
    let mut out = Vec::new();
    for image in list.iter() {
        if let Some(repeat) = image.get("data").and_then(|d| d.get("$repeat")).and_then(Json::as_str) {
            let count = image.get("data").and_then(|d| d.get("count")).and_then(Json::as_number).unwrap_or(0.0) as usize;
            let tail = image.get("data").and_then(|d| d.get("tail")).and_then(Json::as_str).map(|s| s.to_string_lossy()).unwrap_or_default();
            let mut data = String::new();
            let ch = repeat.to_string_lossy();
            for _ in 0..count {
                data.push_str(&ch);
            }
            data.push_str(&tail);
            let mut object = pinomad_core::json::JsonObject::new();
            object.set(U16String::from_str("data"), Json::String(U16String::from_str(&data)));
            if let Some(mime) = image.get("mimeType") {
                object.set(U16String::from_str("mimeType"), mime.clone());
            }
            out.push(Json::Object(std::sync::Arc::new(object)));
        } else {
            out.push(image.clone());
        }
    }
    Json::array(out)
}

#[test]
fn misc_replays() {
    let file = load("misc");
    for case in cases(&file, "pendingQuestions") {
        let name = as_text(field(case, "name"));
        let docs = Json::parse(&as_text(field(case, "docs"))).unwrap();
        let docs = docs.as_array().expect("docs");
        let got = derive_vectors::out::pending_questions_json(&pinomad_core::questions::pending_questions(docs));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "questionAnswers") {
        let name = as_text(field(case, "name"));
        let count = field(case, "questionCount").as_number().unwrap() as usize;
        let selections: Vec<Vec<String>> = Json::parse(&as_text(field(case, "selections")))
            .unwrap()
            .as_array()
            .expect("selections")
            .iter()
            .map(|sel| sel.as_array().map(|v| v.iter().filter_map(|x| x.as_str().map(|s| s.to_string_lossy())).collect()).unwrap_or_default())
            .collect();
        let others: Vec<String> = Json::parse(&as_text(field(case, "others")))
            .unwrap()
            .as_array()
            .expect("others")
            .iter()
            .filter_map(|o| o.as_str().map(|s| s.to_string_lossy()))
            .collect();
        let got = derive_vectors::out::question_answers_json(&pinomad_core::questions::question_answers(count, &selections, &others));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "folderCrumbs") {
        let name = as_text(field(case, "name"));
        let got = derive_vectors::out::folder_crumbs_json(&pinomad_core::folder_path::folder_crumbs(
            &as_text(field(case, "path")),
            &as_text(field(case, "home")),
        ));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "parentFolder") {
        let name = as_text(field(case, "name"));
        let got = opt_json(pinomad_core::folder_path::parent_folder(&as_text(field(case, "path"))).map(|p| Json::String(U16String::from_str(&p))));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "parseStoredHost") {
        let name = as_text(field(case, "name"));
        let value = wire_field(case, "value").unwrap_or(Json::Null);
        let got = derive_vectors::out::stored_host_json(pinomad_core::stored_host::parse_stored_host(&value).as_ref());
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "hostLabels") {
        let name = as_text(field(case, "name"));
        let hosts: Vec<_> = Json::parse(&as_text(field(case, "hosts")))
            .unwrap()
            .as_array()
            .expect("hosts")
            .iter()
            .map(derive_vectors::input::stored_host)
            .collect();
        let got = derive_vectors::out::host_labels_json(&pinomad_core::stored_host::host_labels(&hosts));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "classifyProviderFailure") {
        let name = as_text(field(case, "name"));
        let error = wire_field(case, "error").unwrap_or(Json::Null);
        let kind = pinomad_core::provider_failure::classify_provider_failure(&error);
        let got = Json::String(U16String::from_str(kind.as_str()));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    for case in cases(&file, "imageProblem") {
        let name = as_text(field(case, "name"));
        let images = image_images(case);
        let got = opt_json(
            pinomad_core::images::image_problem(&images).map(|p| Json::String(U16String::from_str(&p))),
        );
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
    assert_eq!(
        Json::Number(pinomad_core::images::MAX_IMAGES_PER_MESSAGE as f64).to_json(),
        as_text(field(&file, "maxImagesPerMessage")),
        "MAX_IMAGES_PER_MESSAGE"
    );
}

#[test]
fn tool_diff_stat_replays() {
    let file = load("tools");
    for case in cases(&file, "toolDiffStatFromResult") {
        let name = as_text(field(case, "name"));
        let result = Json::parse(&as_text(field(case, "result"))).unwrap();
        let got = opt_json(tool_diff_stat_from_result(&result).map(|stat| {
            let mut object = pinomad_core::json::JsonObject::new();
            object.set(U16String::from_str("additions"), Json::Number(stat.additions));
            object.set(U16String::from_str("deletions"), Json::Number(stat.deletions));
            Json::Object(std::sync::Arc::new(object))
        }));
        assert_eq!(
norm(&got),
expect_text(case), "{name}");
    }
}
