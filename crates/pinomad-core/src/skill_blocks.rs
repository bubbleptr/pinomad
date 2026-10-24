// `stripUserBlocks` (issues #308, #321) — the text the user typed, from a
// `pi.user` message the host may have prefixed with `$name` skill blocks and
// appended an attachments block to, plus those blocks' contents.
// The TypeScript reference is `packages/client/src/skill-blocks.ts`; this is
// the same literal scanner over UTF-16 units, and the shared case table
// replays here byte-for-byte. A skill block is
// `<skill name="N" location="L">\nReferences are relative to B.\n\n…\n</skill>`
// with N in `[a-z0-9-]+`, L non-empty without `"` or a newline, B non-empty,
// the body ending at the first `\n</skill>`; each strips only when `\n\n` and
// a non-empty rest follow it, and only from the very start of the text.
// The attachments block is the exact v1 shape written by
// `packages/protocol/src/attachments.ts`; it is recognized only when a whole
// content text block is that block. A string message, or a text block with
// prose around the block, stays text.

use crate::json::Json;
use crate::u16str::U16String;

const OPEN: &str = "<skill name=\"";
const LOCATION: &str = "\" location=\"";
const REFERENCES: &str = "\">\nReferences are relative to ";
const CLOSE: &str = "\n</skill>";
const SEPARATOR: &str = "\n\n";

const ATTACHMENTS_OPEN: &str = "<attachments v=\"1\">";
const ATTACHMENTS_INSTRUCTION: &str = "The user attached these files. They are read-only originals on this machine: read them with your tools when relevant, and copy one into the working directory before changing it.";
const ATTACHMENTS_END: &str = "\n</attachments>";
const FILE_OPEN: &str = "<file id=\"";
const FILE_NAME: &str = "\" name=\"";
const FILE_PATH: &str = "\" path=\"";
const FILE_SIZE: &str = "\" size=\"";
const FILE_END: &str = "\"/>";

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
    units.len() >= at + prefix.len()
        && units[at..at + prefix.len()]
            .iter()
            .zip(prefix)
            .all(|(&u, &b)| u == b as u16)
}

/// `text.indexOf(needle, from)` for an ASCII `needle`.
fn index_of(units: &[u16], from: usize, needle: &str) -> Option<usize> {
    (from..=units.len().saturating_sub(needle.len())).find(|&i| starts_with(units, i, needle))
}

/// Where the skill block starting at `at` ends (just past `</skill>`), if one starts there.
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
    if line_end - i < 2
        || units[line_end - 1] != PERIOD
        || units.get(line_end + 1) != Some(&NEWLINE)
    {
        return None;
    }
    // The body may be empty: the blank line's own newline then opens the close tag.
    let close = index_of(units, line_end + 1, CLOSE)?;
    Some(close + CLOSE.len())
}

/// One file of an attachments block, as the host recorded it.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct UserAttachment {
    pub id: String,
    pub name: String,
    pub size: u64,
}

/// A `pi.user` message as the user wrote it, plus both kinds of host blocks.
#[derive(Debug, PartialEq)]
pub struct UserBlocks {
    pub text: Vec<u16>,
    pub skills: Vec<String>,
    pub attachments: Vec<UserAttachment>,
}

/// `String(value) === literal` for a JSON string field.
fn str_eq(value: Option<&Json>, literal: &str) -> bool {
    value
        .and_then(Json::as_str)
        .is_some_and(|s| s.units() == U16String::from_str(literal).units())
}

/// `text.startsWith(marker, at)`, then the value up to the next quote; `at`
/// is left at the closing quote so the next marker (which starts with it) lines up.
fn quoted<'a>(units: &'a [u16], at: usize, marker: &str) -> Option<(&'a [u16], usize)> {
    if !starts_with(units, at, marker) {
        return None;
    }
    let start = at + marker.len();
    let end = (start..units.len()).find(|&i| units[i] == QUOTE)?;
    Some((&units[start..end], end))
}

fn ascii_eq(units: &[u16], text: &str) -> bool {
    units.len() == text.len()
        && units
            .iter()
            .zip(text.as_bytes())
            .all(|(&u, &b)| u == b as u16)
}

fn parse_decimal(units: &[u16]) -> Option<u64> {
    if units.is_empty() || (units.len() > 1 && units[0] == b'0' as u16) {
        return None;
    }
    let mut value: u64 = 0;
    for &unit in units {
        if !(0x30..=0x39).contains(&unit) {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((unit - 0x30) as u64)?;
    }
    // `Number.isSafeInteger` in the reference.
    (value <= 9_007_199_254_740_991).then_some(value)
}

fn is_attachment_id(units: &[u16]) -> bool {
    units.len() == 22
        && units
            .iter()
            .all(|&u| matches!(u, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x2d | 0x5f))
}

fn hex_value(units: &[u16]) -> Option<u32> {
    let mut value: u32 = 0;
    for &unit in units {
        let digit = match unit {
            0x30..=0x39 => unit - 0x30,
            0x41..=0x46 => unit - 0x41 + 10,
            0x61..=0x66 => unit - 0x61 + 10,
            _ => return None,
        };
        value = value.checked_mul(16)?.checked_add(digit as u32)?;
    }
    Some(value)
}

fn decimal_code(units: &[u16]) -> Option<u32> {
    let mut value: u32 = 0;
    for &unit in units {
        if !(0x30..=0x39).contains(&unit) {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((unit - 0x30) as u32)?;
    }
    Some(value)
}

/// Decode the entities `xmlAttribute` writes; anything else stays literal.
fn decode_xml(units: &[u16]) -> String {
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        if units[i] != b'&' as u16 {
            out.push(units[i]);
            i += 1;
            continue;
        }
        let Some(end) = units[i + 1..]
            .iter()
            .position(|&u| u == b';' as u16)
            .map(|p| p + i + 1)
        else {
            out.push(units[i]);
            i += 1;
            continue;
        };
        let body = &units[i + 1..end];
        let named = if ascii_eq(body, "amp") {
            Some('&')
        } else if ascii_eq(body, "lt") {
            Some('<')
        } else if ascii_eq(body, "gt") {
            Some('>')
        } else if ascii_eq(body, "quot") {
            Some('"')
        } else if ascii_eq(body, "apos") {
            Some('\'')
        } else {
            None
        };
        if let Some(ch) = named {
            let mut buffer = [0u16; 2];
            out.extend_from_slice(ch.encode_utf16(&mut buffer));
            i = end + 1;
            continue;
        }
        let code = if body.first() == Some(&(b'#' as u16)) {
            if body.get(1) == Some(&(b'x' as u16)) || body.get(1) == Some(&(b'X' as u16)) {
                hex_value(&body[2..])
            } else {
                decimal_code(&body[1..])
            }
        } else {
            None
        };
        if let Some(code) = code.and_then(char::from_u32) {
            let mut buffer = [0u16; 2];
            out.extend_from_slice(code.encode_utf16(&mut buffer));
            i = end + 1;
            continue;
        }
        out.push(units[i]);
        i += 1;
    }
    String::from_utf16_lossy(&out)
}

fn file_line(line: &[u16]) -> Option<UserAttachment> {
    let (id, at) = quoted(line, 0, FILE_OPEN)?;
    let (name, at) = quoted(line, at, FILE_NAME)?;
    let (_, at) = quoted(line, at, FILE_PATH)?;
    let (size, at) = quoted(line, at, FILE_SIZE)?;
    if !starts_with(line, at, FILE_END) || at + FILE_END.len() != line.len() {
        return None;
    }
    if !is_attachment_id(id) {
        return None;
    }
    Some(UserAttachment {
        id: String::from_utf16_lossy(id),
        name: decode_xml(name),
        size: parse_decimal(size)?,
    })
}

/// The files of an exact v1 block, or None when `units` is not one.
fn parse_attachment_block(units: &[u16]) -> Option<Vec<UserAttachment>> {
    if !starts_with(units, 0, ATTACHMENTS_OPEN)
        || units.get(ATTACHMENTS_OPEN.len()) != Some(&NEWLINE)
    {
        return None;
    }
    let open_end = ATTACHMENTS_OPEN.len() + 1;
    if !starts_with(
        units,
        units.len().checked_sub(ATTACHMENTS_END.len())?,
        ATTACHMENTS_END,
    ) {
        return None;
    }
    let inner_end = units.len() - ATTACHMENTS_END.len();
    let inner = &units[open_end..inner_end];
    let lines: Vec<&[u16]> = inner.split(|&u| u == NEWLINE).collect();
    if lines.len() < 2 || !ascii_eq(lines[0], ATTACHMENTS_INSTRUCTION) {
        return None;
    }
    let mut files = Vec::with_capacity(lines.len() - 1);
    for line in &lines[1..] {
        files.push(file_line(line)?);
    }
    Some(files)
}

/// The typed text past every leading skill block, and their names.
fn strip_skill_prefix(units: &[u16]) -> (&[u16], Vec<String>) {
    let mut skills = Vec::new();
    let mut at = 0;
    loop {
        match block_end(units, at) {
            Some(end)
                if starts_with(units, end, SEPARATOR) && end + SEPARATOR.len() != units.len() =>
            {
                // The name is ASCII `[a-z0-9-]+`, from the open tag to its closing quote.
                let name = &units[at + OPEN.len()..];
                let len = name.iter().position(|&u| u == QUOTE).unwrap_or(0);
                skills.push(String::from_utf16_lossy(&name[..len]));
                at = end + SEPARATOR.len();
            }
            _ => break,
        }
    }
    (&units[at..], skills)
}

/// The typed text, skills, and attachments of a `pi.user` content value.
/// Attachments come only from a whole text block that is exactly the v1
/// block; a string or a mixed text block is regular text.
pub fn strip_user_blocks(content: Option<&Json>) -> UserBlocks {
    let mut joined: Vec<u16> = Vec::new();
    let mut attachments = Vec::new();
    match content {
        Some(Json::String(text)) => joined.extend_from_slice(text.units()),
        Some(Json::Array(items)) => {
            for block in items.iter() {
                if !str_eq(block.get("type"), "text") {
                    continue;
                }
                let Some(text) = block.get("text").and_then(Json::as_str) else {
                    continue;
                };
                if let Some(files) = parse_attachment_block(text.units()) {
                    attachments.extend(files);
                } else {
                    joined.extend_from_slice(text.units());
                }
            }
        }
        _ => {}
    }
    let (text, skills) = strip_skill_prefix(&joined);
    UserBlocks {
        text: text.to_vec(),
        skills,
        attachments,
    }
}
