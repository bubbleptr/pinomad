// JavaScript string semantics on UTF-16 code units. The derivations the TS
// reference computes — trim, case folding, substring search, slicing — all
// operate on code units, not Unicode scalars, so the same text lands here
// exactly as the reference sees it, lone surrogates included.

use crate::u16str::U16String;

/// The character set `String#trim` and the `\s` regex class match: White_Space
/// and the line terminators — Rust's `char::is_whitespace` additionally counts
/// U+0085 NEL, which JavaScript does not.
pub fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680
            | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `String#trim`.
pub fn trim(units: &[u16]) -> &[u16] {
    match units.iter().position(|&u| !is_js_space(u)) {
        Some(start) => {
            let end = units.iter().rposition(|&u| !is_js_space(u)).unwrap() + 1;
            &units[start..end]
        }
        None => &[],
    }
}

/// `String#toLowerCase` — per-scalar lowercasing. The full Unicode mapping is
/// context-sensitive for a single Greek rule (final sigma); the reference's
/// inputs never reach it, so the simpler context-free mapping is used here.
pub fn to_lowercase(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        let (ch, width) = decode_scalar(units, index);
        match ch {
            Some(c) => {
                for lc in c.to_lowercase() {
                    out.extend_from_slice(lc.encode_utf16(&mut [0u16; 2]));
                }
            }
            None => out.push(units[index]),
        }
        index += width;
    }
    out
}

/// A unit after Canonicalize for a case-insensitive match (the non-Unicode
/// regex path: toUpperCase, but only when it maps to a single code unit).
pub fn canon(unit: u16) -> u16 {
    match char::from_u32(unit as u32) {
        Some(c) => {
            let mut up = c.to_uppercase();
            match (up.next(), up.next()) {
                (Some(c), None) if (c as u32) <= 0xffff => c as u16,
                _ => unit,
            }
        }
        None => unit,
    }
}

/// `String#indexOf` — first position of `needle` in `haystack`, in units.
pub fn index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

pub fn last_index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// `String#includes` — substring search on units.
pub fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    index_of(haystack, needle).is_some()
}

/// Decode the scalar at `index`: one unit, or two for a surrogate pair.
/// Returns the char and the unit width; a lone surrogate decodes to None.
fn decode_scalar(units: &[u16], index: usize) -> (Option<char>, usize) {
    let unit = units[index];
    if (0xd800..=0xdbff).contains(&unit) && index + 1 < units.len() && (0xdc00..=0xdfff).contains(&units[index + 1]) {
        let high = (unit as u32) - 0xd800;
        let low = (units[index + 1] as u32) - 0xdc00;
        (char::from_u32(0x10000 + ((high << 10) | low)), 2)
    } else {
        (char::from_u32(unit as u32), 1)
    }
}

/// `String#startsWith` — prefix check on units.
pub fn starts_with(units: &[u16], prefix: &[u16]) -> bool {
    units.len() >= prefix.len() && &units[..prefix.len()] == prefix
}

/// `String#endsWith`.
pub fn ends_with(units: &[u16], suffix: &[u16]) -> bool {
    units.len() >= suffix.len() && &units[units.len() - suffix.len()..] == suffix
}

/// `String#slice(start, end)` — negative offsets count back from the end.
pub fn slice(units: &[u16], start: i64, end: Option<i64>) -> Vec<u16> {
    let len = units.len() as i64;
    let from = (if start < 0 { len + start } else { start }).clamp(0, len) as usize;
    let to = match end {
        Some(e) => (if e < 0 { len + e } else { e }).clamp(0, len) as usize,
        None => units.len(),
    };
    units[from.min(to)..to.max(from)].to_vec()
}

/// `${value + 1}` inside a template literal, JS `+` semantics: a number adds,
/// a string concatenates, anything else is NaN.
pub fn plus_one(value: Option<&crate::json::Json>) -> Vec<u16> {
    match value {
        Some(crate::json::Json::Number(v)) => crate::json::number_to_units(v + 1.0),
        Some(crate::json::Json::String(s)) => {
            let mut out = s.units().to_vec();
            out.push(b'1' as u16);
            out
        }
        _ => b"NaN".iter().map(|&b| b as u16).collect(),
    }
}

/// `String(value)` where the value may be absent: `undefined` renders as
/// `"undefined"` in a template string.
pub fn string_of(value: Option<&crate::json::Json>) -> Vec<u16> {
    match value {
        Some(v) => U16String::js_string(v).0,
        None => b"undefined".iter().map(|&b| b as u16).collect(),
    }
}

/// `value.trim() === ""` on code units — the blank-text check the reference
/// makes before treating a prompt as empty.
pub fn is_blank(units: &[u16]) -> bool {
    trim(units).is_empty()
}

/// `text.trim() === ""` on a Rust string.
pub fn is_blank_str(text: &str) -> bool {
    text.chars().all(|c| (c as u32) <= 0xffff && is_js_space(c as u16))
}
