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
