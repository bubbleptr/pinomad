import { describe, expect, it } from "vitest";
import { skillMentionRanges, type MentionRange } from "../src/skill-mentions.ts";
import { SKILL_MENTION_CASES } from "./skill-mentions-cases.ts";

// The spec's expected results, in UTF-16 half-open ranges — kept here because
// the shared case table feeds the Rust comparison vectors too (issue #143).
const EXPECTED: Record<string, MentionRange[]> = {
  "whole-text": [{ start: 0, end: 7 }],
  "at-end": [{ start: 11, end: 18 }],
  "mid-sentence": [{ start: 4, end: 11 }],
  "hyphenated-name": [{ start: 0, end: 12 }],
  "leading-hyphen": [{ start: 0, end: 3 }],
  "double-dollar": [],
  "after-crlf": [{ start: 5, end: 12 }],
  "after-nbsp": [{ start: 2, end: 9 }],
  "after-ideographic-space": [{ start: 1, end: 8 }],
  "cjk-before": [],
  "cjk-after": [{ start: 0, end: 7 }],
  "cjk-around": [{ start: 2, end: 9 }],
  "emoji-prefix-offset": [{ start: 3, end: 10 }],
  "letter-follower": [{ start: 0, end: 10 }],
  "digit-follower": [],
  "underscore-follower": [],
  "dollar-follower": [],
  "longest-run-misses": [],
  "longest-run-hits": [{ start: 0, end: 13 }],
  "case-sensitive": [{ start: 16, end: 23 }],
  "hyphen-candidate": [{ start: 0, end: 8 }],
  "empty-candidate": [],
  repeated: [
    { start: 0, end: 7 },
    { start: 13, end: 20 },
    { start: 25, end: 32 },
  ],
  "digit-name": [{ start: 4, end: 11 }],
  "empty-names": [],
  "unknown-name": [],
  "trailing-dollar": [],
  "emoji-follower": [{ start: 0, end: 7 }],
};

describe("skillMentionRanges", () => {
  it.each(SKILL_MENTION_CASES)("$name", ({ name, text, names }) => {
    expect(skillMentionRanges(text, names)).toEqual(EXPECTED[name]);
  });

  it("counts UTF-16 units, not code points", () => {
    // A sanity check the expected table doesn't make obvious: the emoji takes
    // two units, so the range starts at 3.
    expect(skillMentionRanges("😀 $x", ["x"])).toEqual([{ start: 3, end: 5 }]);
  });
});
