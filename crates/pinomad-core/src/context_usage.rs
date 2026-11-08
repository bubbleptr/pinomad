// The context-window usage of the shown conversation — packages/client/src/
// context-usage.ts, after pi's AgentSession.getContextUsage: the newest
// qualifying assistant entry's usage is the context the model actually saw
// at that call, so it stays the meter's truth until the next reply lands.

use crate::json::Json;
use crate::u16str::U16String;

/// Tokens the last qualifying reply reported seeing, against the shown
/// model's window. `used` may exceed `window` after a model swap.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ContextUsage {
    pub used: f64,
    pub window: f64,
}

fn str_eq(value: Option<&Json>, literal: &str) -> bool {
    value
        .and_then(Json::as_str)
        .is_some_and(|s| s.units() == U16String::from_str(literal).units())
}

/// Upstream `calculateContextTokens`: `totalTokens || input + output +
/// cacheRead + cacheWrite` — a provider's own total wins when it reports
/// one; a missing component degrades to NaN like the reference's `undefined`
/// arithmetic.
fn context_tokens(usage: &Json) -> f64 {
    match usage.get("totalTokens") {
        Some(total) if total.truthy() => total.as_number().unwrap_or(f64::NAN),
        _ => ["input", "output", "cacheRead", "cacheWrite"]
            .iter()
            .map(|key| usage.get(key).and_then(Json::as_number).unwrap_or(f64::NAN))
            .sum(),
    }
}

/// `contextUsage(view, contextWindow)` — the newest qualifying assistant
/// usage since the last `pi.compaction`/`pi.reset`, or `None` when nothing
/// qualifies. A compaction/reset entry ends the backward scan: the last
/// reply's usage predates the cut and cannot be trusted until the next
/// response arrives. An aborted or failed reply and a zero-usage message
/// carry no trustworthy count and are skipped.
pub fn context_usage(view: &Json, context_window: Option<f64>) -> Option<ContextUsage> {
    // `!(contextWindow > 0)` — a NaN or non-positive window is no scale.
    let window = context_window.filter(|window| *window > 0.0)?;
    let entries = view.get("entries").and_then(Json::as_array)?;
    for entry in entries.iter().rev() {
        let kind = entry.get("kind");
        if str_eq(kind, "pi.compaction") || str_eq(kind, "pi.reset") {
            return None;
        }
        if !str_eq(kind, "pi.assistant") {
            continue;
        }
        let Some(message) = entry
            .get("model")
            .and_then(Json::as_array)
            .and_then(|model| model.first())
        else {
            continue;
        };
        if !str_eq(message.get("role"), "assistant") {
            continue;
        }
        if str_eq(message.get("stopReason"), "aborted") || str_eq(message.get("stopReason"), "error") {
            continue;
        }
        let used = message.get("usage").map(context_tokens).unwrap_or(f64::NAN);
        if !(used > 0.0) {
            continue;
        }
        return Some(ContextUsage { used, window });
    }
    None
}

/// The host's context breakdown while it belongs to the reply the meter
/// counts — the web's `matchingBreakdown`. The host stamps it with that
/// reply's own usage, so a different `used` means another reply (a newer one
/// not yet broken down, or a fork's parent) and no meter means a compaction
/// or reset made it stale. `docs` are the view's `{kind, presentation, value}`.
pub fn matching_breakdown(docs: &[Json], usage: Option<ContextUsage>) -> Option<crate::presentation::ContextBreakdown> {
    let usage = usage?;
    docs.iter().find_map(|doc| {
        let value = doc.get("value").cloned().unwrap_or(Json::Null);
        match crate::presentation::classify(doc.get("presentation"), &value) {
            crate::presentation::ClassifiedDoc::Context(context) if context.parts.used == usage.used => Some(context.parts),
            _ => None,
        }
    })
}

#[cfg(test)]
mod breakdown_tests {
    use super::*;

    const PARTS: &str = r#"{"used":124000,"system":8100,"skills":3200,"tools":12000,"mcp":0,"messages":100700}"#;
    const USAGE: ContextUsage = ContextUsage { used: 124000.0, window: 200000.0 };

    fn doc(presentation: Option<&str>, value: &str) -> Json {
        let presentation = presentation.map(|p| format!(r#","presentation":"{p}""#)).unwrap_or_default();
        Json::parse(&format!(r#"{{"kind":"context.breakdown"{presentation},"value":{value}}}"#)).unwrap()
    }

    #[test]
    fn returns_the_breakdown_while_it_belongs_to_the_reply_the_meter_shows() {
        let found = matching_breakdown(&[doc(Some("pinomad.context"), PARTS)], Some(USAGE)).unwrap();
        assert_eq!((found.used, found.system, found.tools, found.messages), (124000.0, 8100.0, 12000.0, 100700.0));
    }

    #[test]
    fn drops_another_reply_a_missing_meter_and_a_malformed_document() {
        let other = r#"{"used":90000,"system":8100,"skills":3200,"tools":12000,"mcp":0,"messages":66700}"#;
        assert!(matching_breakdown(&[doc(Some("pinomad.context"), other)], Some(USAGE)).is_none());
        assert!(matching_breakdown(&[doc(Some("pinomad.context"), PARTS)], None).is_none());
        assert!(matching_breakdown(&[doc(Some("pinomad.context"), r#"{"used":124000}"#)], Some(USAGE)).is_none());
        assert!(matching_breakdown(&[doc(None, PARTS)], Some(USAGE)).is_none());
    }
}
