// `toolTarget` from packages/protocol/src/tool-target.ts: one short "what is
// this tool working on" string for a call's arguments — the card's subtitle.

use crate::json::Json;
use crate::text;
use crate::u16str::U16String;

/// Argument keys that name what a tool acted on, most specific first.
const TARGET_KEYS: [&str; 11] = [
    "path",
    "file_path",
    "filePath",
    "command",
    "cmd",
    "query",
    "pattern",
    "url",
    "name",
    // Subagent calls label their card with the short description, then the task.
    "description",
    "task",
];

const TARGET_MAX_LENGTH: usize = 120;

/// The first recognized target-ish argument value, truncated at 120 code
/// units like the reference; absent when none matches.
pub fn tool_target(args: &Json) -> Option<String> {
    if !args.is_object() {
        return None;
    }
    for key in TARGET_KEYS {
        let value = args.get(key);
        if let Some(text) = value.and_then(Json::as_str) {
            if !text.is_empty() {
                let units = text.units();
                return Some(if units.len() > TARGET_MAX_LENGTH {
                    let mut truncated = text::slice(units, 0, Some(TARGET_MAX_LENGTH as i64));
                    truncated.push(0x2026); // …
                    U16String(truncated).to_string_lossy()
                } else {
                    text.to_string_lossy()
                });
            }
        }
    }
    None
}
