import { describe, expect, it } from "vitest";
import { stripSkillBlocks, withSkillBlocks } from "../src/skill-blocks.ts";
import { SKILL_BLOCK_CASES, block } from "./skill-blocks-cases.ts";

// The expected display text per case — kept here because the shared table
// feeds the Rust comparison vectors too (issue #308).
const EXPECTED: Record<string, string> = {
  "no-block": "$review do x",
  "one-block": "$review do x",
  "two-blocks": "run $deploy after $review",
  "empty-body": "$review",
  "multiline-text": "$review\nthen\n\n",
  "not-at-start": `see\n\n${block("review", "Steps.")}\n\n$review`,
  "block-only": block("review", "Steps."),
  "block-then-separator-only": `${block("review", "Steps.")}\n\n`,
  "single-newline-separator": `${block("review", "Steps.")}\n$review`,
  unclosed: `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\n\nSteps.\n\n$review`,
  "uppercase-name": `${block("Review", "Steps.")}\n\n$Review`,
  "empty-name": `${block("", "Steps.")}\n\nhi`,
  "missing-references-line": `<skill name="review" location="/s/SKILL.md">\n\nSteps.\n</skill>\n\n$review`,
  "missing-blank-line": `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\nSteps.\n</skill>\n\n$review`,
  "quote-in-location": `<skill name="review" location="/a"b/SKILL.md">\nReferences are relative to /a"b.\n\nSteps.\n</skill>\n\n$review`,
  "leading-space": ` ${block("review", "Steps.")}\n\n$review`,
  "second-block-malformed": `<skill name="x">\n$review`,
  "two-blocks-no-text": block("deploy", "Deploy."),
  unicode: "用 $review 😀",
};

describe("stripSkillBlocks", () => {
  it.each(SKILL_BLOCK_CASES)("$name", ({ name, text }) => {
    expect(stripSkillBlocks(text)).toBe(EXPECTED[name]);
  });

  it("covers every case in the shared table", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(SKILL_BLOCK_CASES.map((c) => c.name).sort());
  });
});

describe("withSkillBlocks", () => {
  const review = { name: "review", location: "/s/review/SKILL.md", baseDir: "/s/review", body: "Review steps." };

  it("writes pi-coding-agent's /skill: block, then the user's text", () => {
    expect(withSkillBlocks([review], "$review do x")).toBe(
      `<skill name="review" location="/s/review/SKILL.md">\nReferences are relative to /s/review.\n\nReview steps.\n</skill>\n\n$review do x`,
    );
  });

  it("leaves the text alone without blocks", () => {
    expect(withSkillBlocks([], "$review do x")).toBe("$review do x");
  });

  it("round-trips through stripSkillBlocks", () => {
    const deploy = { name: "deploy", location: "/s/deploy/SKILL.md", baseDir: "/s/deploy", body: "" };
    for (const text of ["$review", "$deploy then $review\n", "  $review  "]) {
      expect(stripSkillBlocks(withSkillBlocks([deploy, review], text))).toBe(text);
    }
  });
});
