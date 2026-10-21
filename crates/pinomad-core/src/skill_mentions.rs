// `skillMentionRanges` (issue #143) — the `$name` mention ranges in a draft
// or a sent message, as UTF-16 half-open offsets. The TypeScript reference
// is `packages/client/src/skill-mentions.ts`; the shared case table replays
// here byte-for-byte. The rules are lexical: a `$` starts a candidate only at
// the text's start or after Unicode White_Space (paths like `/etc/hosts` and
// words like `pre$name` never match); the candidate is the longest
// `[a-z0-9-]+` run — leading hyphens included, the matcher delimits names the
// host's validator would reject; the name must be in `names` exactly,
// case-sensitive; and the following scalar must not be a letter, a number,
// `_`, or `$`.

use std::collections::HashSet;

use crate::text::decode_scalar;
use crate::u16str::U16String;

/// One `$name` match, in UTF-16 units: `start` at the `$`, `end` just after
/// the name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct MentionRange {
    pub start: u32,
    pub end: u32,
}

/// `[a-z0-9-]` on a unit — the candidate charset is all ASCII.
fn is_name_unit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x61..=0x7a | 0x2d)
}

/// `\p{Alphabetic}\p{N}_$` — `char::is_alphabetic` is the Alphabetic property
/// and `is_numeric` the `N` categories, the same sets the reference's regex
/// matches. A lone surrogate is none of them.
fn blocks_follow(units: &[u16], index: usize) -> bool {
    match decode_scalar(units, index) {
        (Some(c), _) => c.is_alphabetic() || c.is_numeric() || c == '_' || c == '$',
        (None, _) => false,
    }
}

/// Unicode White_Space — `\p{White_Space}` in the reference; whitespace is
/// all BMP, so a unit check is a char check here.
fn is_space(unit: u16) -> bool {
    char::from_u32(unit as u32).is_some_and(char::is_whitespace)
}

pub fn skill_mention_ranges(text: &U16String, names: &HashSet<U16String>) -> Vec<MentionRange> {
    let units = text.units();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < units.len() {
        if units[i] != 0x24 {
            // $
            i += 1;
            continue;
        }
        if i > 0 && !is_space(units[i - 1]) {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < units.len() && is_name_unit(units[end]) {
            end += 1;
        }
        if !names.contains(&U16String(units[i + 1..end].to_vec())) || (end < units.len() && blocks_follow(units, end)) {
            i += 1;
            continue;
        }
        ranges.push(MentionRange {
            start: i as u32,
            end: end as u32,
        });
        i = end;
    }
    ranges
}
