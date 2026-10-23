// `stripSkillBlocks` (issue #308, ADR-0028) — the text the user typed, from
// a `pi.user` message the host may have prefixed with `$name` skill blocks,
// and the names of the blocks it stripped.
// The TypeScript reference is `packages/client/src/skill-blocks.ts`; this is
// the same literal scanner over UTF-16 units, and the shared case table
// replays here byte-for-byte. A block is
// `<skill name="N" location="L">\nReferences are relative to B.\n\n…\n</skill>`
// with N in `[a-z0-9-]+`, L non-empty without `"` or a newline, B non-empty,
// the body ending at the first `\n</skill>`; each strips only when `\n\n` and
// a non-empty rest follow it, and only from the very start of the text.

const OPEN: &str = "<skill name=\"";
const LOCATION: &str = "\" location=\"";
const REFERENCES: &str = "\">\nReferences are relative to ";
const CLOSE: &str = "\n</skill>";
const SEPARATOR: &str = "\n\n";

const NEWLINE: u16 = b'\n' as u16;
const QUOTE: u16 = b'"' as u16;
const PERIOD: u16 = b'.' as u16;

/// `[a-z0-9-]` — every name a `$` mention can match.
fn is_name_unit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x61..=0x7a | 0x2d)
}

/// `text.startsWith(prefix, at)` for an ASCII `prefix`.
fn starts_with(units: &[u16], at: usize, prefix: &str) -> bool {
    let prefix = prefix.as_bytes();
    units.len() >= at + prefix.len() && units[at..at + prefix.len()].iter().zip(prefix).all(|(&u, &b)| u == b as u16)
}

/// `text.indexOf(needle, from)` for an ASCII `needle`.
fn index_of(units: &[u16], from: usize, needle: &str) -> Option<usize> {
    (from..=units.len().saturating_sub(needle.len())).find(|&i| starts_with(units, i, needle))
}

/// Where the block starting at `at` ends (just past `</skill>`), if one starts there.
fn block_end(units: &[u16], at: usize) -> Option<usize> {
    if !starts_with(units, at, OPEN) {
        return None;
    }
    let mut i = at + OPEN.len();
    let name = i;
    while i < units.len() && is_name_unit(units[i]) {
        i += 1;
    }
    if i == name || !starts_with(units, i, LOCATION) {
        return None;
    }
    i += LOCATION.len();
    let location = i;
    while i < units.len() && units[i] != QUOTE && units[i] != NEWLINE {
        i += 1;
    }
    if i == location || !starts_with(units, i, REFERENCES) {
        return None;
    }
    i += REFERENCES.len();
    // The references line: a non-empty base dir, a period, then a blank line.
    let line_end = units[i..].iter().position(|&u| u == NEWLINE)? + i;
    if line_end - i < 2 || units[line_end - 1] != PERIOD || units.get(line_end + 1) != Some(&NEWLINE) {
        return None;
    }
    // The body may be empty: the blank line's own newline then opens the close tag.
    let close = index_of(units, line_end + 1, CLOSE)?;
    Some(close + CLOSE.len())
}

/// A `pi.user` message as the user wrote it.
#[derive(Debug, PartialEq)]
pub struct UserText<'a> {
    /// `text` past every leading skill block, or `text` itself when none strips.
    pub text: &'a [u16],
    /// The stripped blocks' names, in order — a bubble highlights `$name`
    /// only for these, a queued edit restores them as chips.
    pub skills: Vec<String>,
}

pub fn strip_skill_blocks(units: &[u16]) -> UserText<'_> {
    let mut skills = Vec::new();
    let mut at = 0;
    loop {
        match block_end(units, at) {
            Some(end) if starts_with(units, end, SEPARATOR) && end + SEPARATOR.len() != units.len() => {
                // The name is ASCII `[a-z0-9-]+`, from the open tag to its closing quote.
                let name = &units[at + OPEN.len()..];
                let len = name.iter().position(|&u| u == QUOTE).unwrap_or(0);
                skills.push(String::from_utf16_lossy(&name[..len]));
                at = end + SEPARATOR.len();
            }
            _ => return UserText { text: &units[at..], skills },
        }
    }
}
