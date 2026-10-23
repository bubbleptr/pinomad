// ConversationSummary decoding for the 5.18 `currentAgent` field (ADR-0023):
// additive, so a pre-5.18 shape still decodes and an explicit null reads as no
// agent. The FFI copy keeps the field for the native clients.
use pinomad_core::json::Json;
use pinomad_core::organization::ConversationSummary;

fn summary(text: &str) -> ConversationSummary {
    ConversationSummary::new(Json::parse(text).expect("summary JSON"))
}

#[test]
fn decodes_current_agent_and_keeps_role() {
    let value =
        summary(r#"{"id":1,"kind":"conversation","role":"reviewer","currentAgent":"planner"}"#);
    assert_eq!(value.role.as_deref(), Some("reviewer"));
    assert_eq!(value.current_agent.as_deref(), Some("planner"));
    assert_eq!(
        value
            .to_json()
            .get("currentAgent")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy()),
        Some("planner".to_string())
    );
}

#[test]
fn decodes_a_pre_5_18_summary_without_the_field() {
    let value = summary(r#"{"id":1,"kind":"fork","role":"reviewer"}"#);
    assert_eq!(value.role.as_deref(), Some("reviewer"));
    assert_eq!(value.current_agent, None);
    // The raw document still carries every field an older client knows.
    assert_eq!(
        value
            .to_json()
            .get("role")
            .and_then(Json::as_str)
            .map(|s| s.to_string_lossy()),
        Some("reviewer".to_string())
    );
}

#[test]
fn decodes_an_explicit_null_as_no_current_agent() {
    let value = summary(r#"{"id":1,"kind":"conversation","role":"reviewer","currentAgent":null}"#);
    assert_eq!(value.role.as_deref(), Some("reviewer"));
    assert_eq!(value.current_agent, None);
}

#[cfg(feature = "ffi")]
#[test]
fn ffi_summary_keeps_current_agent() {
    let core =
        summary(r#"{"id":1,"kind":"conversation","role":"reviewer","currentAgent":"planner"}"#);
    let ffi = pinomad_core::ffi::ConversationSummary::from_core(core);
    assert_eq!(ffi.role.as_deref(), Some("reviewer"));
    assert_eq!(ffi.current_agent.as_deref(), Some("planner"));
}
