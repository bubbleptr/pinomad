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
            derive_vectors::out::chat_entries_json(&entries).to_json(),
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
            derive_vectors::out::retry_json(retry_of(&entries).as_ref()).to_json(),
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
            derive_vectors::out::split_json(&split_subagent_calls(&cot)).to_json(),
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
        assert_eq!(derive_vectors::out::agent_json(&agent_of(&view)).to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "statusText") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        let got = Json::String(U16String::from_str(&status_text(&view)));
        assert_eq!(got.to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "queueItems") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(derive_vectors::out::queue_items_json(&queue_items(&view)).to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "usageRows") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(derive_vectors::out::usage_rows_json(&usage_rows(&view)).to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "taskRows") {
        let name = as_text(field(case, "name"));
        let graph = Json::parse(&as_text(field(case, "graph"))).unwrap();
        assert_eq!(derive_vectors::out::task_rows_json(&task_rows(&graph)).to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "isBusy") {
        let name = as_text(field(case, "name"));
        let view = Json::parse(&as_text(field(case, "view"))).unwrap();
        assert_eq!(Json::Bool(is_busy(&view)).to_json(), expect_text(case), "{name}");
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
        assert_eq!(derive_vectors::out::classified_json(&classified).to_json(), expect_text(case), "{name}");
    }
}

#[test]
fn tool_target_replays() {
    let file = load("tools");
    for case in cases(&file, "toolTarget") {
        let name = as_text(field(case, "name"));
        let args = Json::parse(&as_text(field(case, "args"))).unwrap();
        let got = opt_json(tool_target(&args).map(|t| Json::String(U16String::from_str(&t))));
        assert_eq!(got.to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "toolTargetFromArgs") {
        let name = as_text(field(case, "name"));
        let args_text = wire_field(case, "argsText").and_then(|v| v.as_str().map(|s| s.to_string_lossy()));
        let got = opt_json(tool_target_from_args(args_text.as_deref()).map(|t| Json::String(U16String::from_str(&t))));
        assert_eq!(got.to_json(), expect_text(case), "{name}");
    }
}

#[test]
fn tool_item_helpers_replay() {
    let file = load("tools");
    for case in cases(&file, "toolDisplayName") {
        let name = as_text(field(case, "name"));
        let input = wire_field(case, "tool").and_then(|v| v.as_str().map(|s| s.to_string_lossy()));
        let got = opt_json(tool_display_name(input.as_deref()).map(|v| Json::String(U16String::from_str(&v))));
        assert_eq!(got.to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "formatToolDuration") {
        let name = as_text(field(case, "name"));
        let input = wire_field(case, "durationMs").and_then(|v| v.as_number());
        let got = opt_json(format_tool_duration(input).map(|v| Json::String(U16String::from_str(&v))));
        assert_eq!(got.to_json(), expect_text(case), "{name}");
    }
    for case in cases(&file, "toolKindFromName") {
        let name = as_text(field(case, "name"));
        let input = wire_field(case, "tool").and_then(|v| v.as_str().map(|s| s.to_string_lossy()));
        let normalized = Json::String(U16String::from_str(&normalize_tool_name(input.as_deref())));
        assert_eq!(normalized.to_json(), as_text(field(case, "normalized")), "{name}: normalized");
        let kind = Json::String(U16String::from_str(tool_kind_from_name(input.as_deref()).as_str()));
        assert_eq!(kind.to_json(), expect_text(case), "{name}");
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
        assert_eq!(kind.to_json(), expect_text(case), "{name}");
    }
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
            Json::Object(std::rc::Rc::new(object))
        }));
        assert_eq!(got.to_json(), expect_text(case), "{name}");
    }
}
