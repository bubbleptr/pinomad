// `parseCommandInput` (issue #254, ADR-0029) — whether a composer's text is a
// host-declared slash command. The TypeScript reference is
// `packages/client/src/command-input.ts`; the shared case table replays here.
// The text must start with `/` at index 0 (no leading whitespace skipped); the
// token after it, up to the first Unicode White_Space, must equal a listed
// name exactly, case-sensitive; the rest with White_Space stripped from both
// ends is `args`, absent when empty. The reference spells the trim out
// instead of `String.prototype.trim`, which would also strip U+FEFF — this is
// the same `char::is_whitespace` set.

use std::collections::HashSet;

use crate::u16str::U16String;

/// A recognized command: its listed name and the trimmed text after it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandInput {
    pub name: U16String,
    pub args: Option<U16String>,
}

/// Unicode White_Space — all BMP, so a unit check is a char check.
fn is_space(unit: u16) -> bool {
    char::from_u32(unit as u32).is_some_and(char::is_whitespace)
}

pub fn parse_command_input(text: &U16String, names: &HashSet<U16String>) -> Option<CommandInput> {
    let units = text.units();
    if units.first() != Some(&0x2f) {
        // /
        return None;
    }
    let mut end = 1;
    while end < units.len() && !is_space(units[end]) {
        end += 1;
    }
    let name = U16String(units[1..end].to_vec());
    if name.is_empty() || !names.contains(&name) {
        return None;
    }
    let mut start = end;
    let mut stop = units.len();
    while start < stop && is_space(units[start]) {
        start += 1;
    }
    while stop > start && is_space(units[stop - 1]) {
        stop -= 1;
    }
    let args = (start < stop).then(|| U16String(units[start..stop].to_vec()));
    Some(CommandInput { name, args })
}
