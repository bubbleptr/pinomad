// Per-edit line stats for tool rows, from tool-diff-stat.ts. Pi's `edit`
// result carries the change twice — `details.patch` as a standard unified
// patch (the authority) and `details.diff` as a display rendering — and emits
// no ready-made counts, so they are derived here. `write` results carry no
// details and get no stats.

use crate::json::Json;
use crate::tool_item::DiffStat;

fn is_digit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39)
}

fn lit(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn read_num(line: &[u16], pos: &mut usize) -> Option<f64> {
    let start = *pos;
    let mut value = 0.0f64;
    while *pos < line.len() && is_digit(line[*pos]) {
        // Digits accumulate as a float, like parseInt on a huge count.
        value = value * 10.0 + (line[*pos] - b'0' as u16) as f64;
        *pos += 1;
    }
    (*pos > start).then_some(value)
}

/// `@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@` — returns (old_count,
/// new_count); a missing count defaults to 1. Text after the closing `@@` is
/// not part of the match, exactly like the anchored regex.
fn hunk_header(line: &[u16]) -> Option<(f64, f64)> {
    if !crate::text::starts_with(line, &lit("@@ -")) {
        return None;
    }
    let mut pos = 4;
    read_num(line, &mut pos)?;
    // Optional `,N`: absent means 1.
    let read_count = |line: &[u16], pos: &mut usize| -> Option<f64> {
        if line.get(*pos) == Some(&(b',' as u16)) {
            *pos += 1;
            read_num(line, pos)
        } else {
            Some(1.0)
        }
    };
    let old = read_count(line, &mut pos)?;
    if line.get(pos) != Some(&(b' ' as u16)) || line.get(pos + 1) != Some(&(b'+' as u16)) {
        return None;
    }
    pos += 2;
    read_num(line, &mut pos)?;
    let new = read_count(line, &mut pos)?;
    crate::text::starts_with(&line[pos..], &lit(" @@")).then_some((old, new))
}

fn stat_from_patch(patch: &[u16]) -> DiffStat {
    let mut additions = 0.0;
    let mut deletions = 0.0;
    // Counters go negative on a malformed patch, exactly as the reference's
    // plain numbers do — saturating would end the hunk early.
    let mut remaining_old = 0.0f64;
    let mut remaining_new = 0.0f64;
    let mut in_hunk = false;

    for line in patch.split(|&u| u == b'\n' as u16) {
        if let Some((old, new)) = hunk_header(line) {
            remaining_old = old;
            remaining_new = new;
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        // Both sides exhausted means the hunk is over: lines after it —
        // including the `--- `/`+++ ` headers of a following file section —
        // are not content.
        if remaining_old == 0.0 && remaining_new == 0.0 {
            in_hunk = false;
            continue;
        }
        match line.first() {
            Some(&c) if c == b' ' as u16 => {
                remaining_old -= 1.0;
                remaining_new -= 1.0;
            }
            Some(&c) if c == b'-' as u16 => {
                remaining_old -= 1.0;
                deletions += 1.0;
            }
            Some(&c) if c == b'+' as u16 => {
                remaining_new -= 1.0;
                additions += 1.0;
            }
            // `\ No newline at end of file` and anything unexpected is not content.
            _ => {}
        }
    }
    DiffStat { additions, deletions }
}

/// `^[+-]\s*\d+ ` — a sign directly before the display diff's line number;
/// context lines lead with a space and elisions are "     ...".
fn display_line_kind(line: &[u16]) -> Option<u16> {
    let sign = *line.first()?;
    if sign != b'+' as u16 && sign != b'-' as u16 {
        return None;
    }
    let mut pos = 1;
    while pos < line.len() && crate::text::is_js_space(line[pos]) {
        pos += 1;
    }
    let start = pos;
    while pos < line.len() && is_digit(line[pos]) {
        pos += 1;
    }
    (pos > start && line.get(pos) == Some(&(b' ' as u16))).then_some(sign)
}

fn stat_from_display_diff(diff: &[u16]) -> DiffStat {
    let mut additions = 0.0;
    let mut deletions = 0.0;
    for line in diff.split(|&u| u == b'\n' as u16) {
        match display_line_kind(line) {
            Some(sign) if sign == b'+' as u16 => additions += 1.0,
            Some(_) => deletions += 1.0,
            None => {}
        }
    }
    DiffStat { additions, deletions }
}

/// The count behind `toolDiffStatFromResult` once `details` is in hand.
pub fn stat_from_details(details: Option<&Json>) -> Option<DiffStat> {
    let details = details?;
    // `typeof details === "object"` admits arrays too; their property reads
    // simply miss, like the reference's destructuring.
    if !details.is_container() {
        return None;
    }
    let stat = match details.get("patch").and_then(Json::as_str) {
        Some(patch) => stat_from_patch(patch.units()),
        None => stat_from_display_diff(details.get("diff").and_then(Json::as_str)?.units()),
    };
    (stat.additions > 0.0 || stat.deletions > 0.0).then_some(stat)
}

/// `toolDiffStatFromResult`: accepts the tool result as a value or a JSON
/// text; `details.patch` wins over the display `details.diff`; a stat with
/// no changed lines collapses to absent.
pub fn tool_diff_stat_from_result(result: &Json) -> Option<DiffStat> {
    let parsed;
    let mut value = result;
    if let Json::String(text) = value {
        parsed = Json::parse(&text.to_string_lossy()).ok()?;
        value = &parsed;
    }
    if !value.is_container() {
        return None;
    }
    stat_from_details(value.get("details"))
}
