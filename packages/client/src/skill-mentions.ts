// `$name` skill mentions (issue #143): where in a draft or a sent message a
// known skill name is being referenced. The composer and the message bubbles
// paint these ranges as highlights — Web via the CSS Custom Highlight API,
// iOS via the same UTF-16 ranges in the native text view — so the rules are
// lexical, never layout or semantics: a `$` starts a candidate only at the
// text's start or after Unicode whitespace (`\p{White_Space}` — paths like
// `/etc/hosts` and words like `pre$name` never match); the candidate is the
// longest `[a-z0-9-]+` run (leading hyphens included — the host validator
// rejects such names, the matcher still delimits them); the name must be in
// `names` exactly, case-sensitive; and the following code point must not be a
// letter, a number, `_`, or `$` (`\p{Alphabetic}\p{N}` — the wider Alphabetic
// property so combining marks still count as word-continuing, matching the
// Rust `char::is_alphabetic` the core replays).

export interface MentionRange {
  /** UTF-16 offset where the match starts, at the `$`. */
  readonly start: number;
  /** UTF-16 offset where the match ends, just after the name. */
  readonly end: number;
}

const WHITESPACE = /\p{White_Space}/u;
const WORD_CHAR = /[\p{Alphabetic}\p{N}_$]/u;

/** `[a-z0-9-]` on a UTF-16 unit — the candidate charset is all ASCII. */
const isNameUnit = (unit: number): boolean =>
  (unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x7a) || unit === 0x2d;

export function skillMentionRanges(text: string, names: readonly string[]): MentionRange[] {
  const known = new Set(names);
  const ranges: MentionRange[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x24) continue; // $
    // Whitespace is all BMP — a unit check is a char check here.
    if (i > 0 && !WHITESPACE.test(text[i - 1]!)) continue;
    let end = i + 1;
    while (end < text.length && isNameUnit(text.charCodeAt(end))) end += 1;
    if (!known.has(text.slice(i + 1, end))) continue;
    // A word char after the name continues the token — `codePointAt` so an
    // astral letter counts as a letter on both platforms.
    if (end < text.length && WORD_CHAR.test(String.fromCodePoint(text.codePointAt(end)!))) continue;
    ranges.push({ start: i, end });
  }
  return ranges;
}
