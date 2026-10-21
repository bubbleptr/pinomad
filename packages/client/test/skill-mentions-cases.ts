// Shared inputs for `skillMentionRanges` (issue #143): the boundary rules the
// spec pins — `$` after whitespace or start, the longest [a-z0-9-]+ run as the
// candidate, exact name match, and a non-word follower. The vitest suite and
// packages/client/test/rust-vectors.ts both consume this table, so the Rust
// `skill_mention_ranges` replays the same cases.
export const SKILL_MENTION_CASES: readonly {
  readonly name: string;
  readonly text: string;
  readonly names: readonly string[];
}[] = [
  // A bare name at the start, at the end, and mid-sentence after a space.
  { name: "whole-text", text: "$review", names: ["review"] },
  { name: "at-end", text: "please run $review", names: ["review"] },
  { name: "mid-sentence", text: "run $review now", names: ["review"] },
  // Hyphens are name chars, a leading one included: the candidate is the
  // longest [a-z0-9-]+ run.
  { name: "hyphenated-name", text: "$code-review please", names: ["code-review"] },
  { name: "leading-hyphen", text: "$-x", names: ["-x"] },
  // `$$review`: the first `$` has an empty candidate, the second follows a `$`.
  { name: "double-dollar", text: "$$review", names: ["review"] },
  // CRLF, NBSP, and a full-width space are all whitespace.
  { name: "after-crlf", text: "one\r\n$review", names: ["review"] },
  { name: "after-nbsp", text: "a $review", names: ["review"] },
  { name: "after-ideographic-space", text: "　$review", names: ["review"] },
  // CJK punctuation is not whitespace — `$review` glued to it never starts,
  // but it is a fine follower.
  { name: "cjk-before", text: "。$review", names: ["review"] },
  { name: "cjk-after", text: "$review。", names: ["review"] },
  { name: "cjk-around", text: "用 $review 吧", names: ["review"] },
  // An emoji is two UTF-16 units: the range counts them.
  { name: "emoji-prefix-offset", text: "😀 $review", names: ["review"] },
  // Word chars keep the word going: no match when a letter, digit, `_`, or
  // `$` follows, whatever the name.
  { name: "letter-follower", text: "$reviewing", names: ["review", "reviewing"] },
  { name: "digit-follower", text: "$review2", names: ["review"] },
  { name: "underscore-follower", text: "$review_", names: ["review"] },
  { name: "dollar-follower", text: "$review$x", names: ["review"] },
  // The candidate is the longest run — `review` inside `review-extra` never
  // matches when only `review` is known, and does when both are.
  { name: "longest-run-misses", text: "$review-extra", names: ["review"] },
  { name: "longest-run-hits", text: "$review-extra", names: ["review", "review-extra"] },
  // Case-sensitive: a name in a different case never matches.
  { name: "case-sensitive", text: "$Review $REVIEW $review", names: ["review"] },
  // A name runs from `-` through a name char — `$-review` is a miss for
  // `review` and a hit for `-review`.
  { name: "hyphen-candidate", text: "$-review", names: ["review", "-review"] },
  // `$` followed by a non-name char has an empty candidate — never a match.
  { name: "empty-candidate", text: "$ and $. and $,", names: ["review"] },
  // Several mentions in one text.
  { name: "repeated", text: "$review then $deploy and $review again", names: ["review", "deploy"] },
  // Digits are name chars: a number-led name matches.
  { name: "digit-name", text: "run $9lives", names: ["9lives"] },
  // Nothing known → nothing matches.
  { name: "empty-names", text: "$review $deploy", names: [] },
  // A `$` before an unknown word is left alone.
  { name: "unknown-name", text: "costs $100", names: ["review"] },
  // A lone `$` at the end has no candidate.
  { name: "trailing-dollar", text: "almost $", names: ["review"] },
  // An emoji follower is not a word char — the mention still ends cleanly.
  { name: "emoji-follower", text: "$review 😀", names: ["review"] },
];
