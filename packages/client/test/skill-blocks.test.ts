import { describe, expect, it } from "vitest";
import { stripSkillBlocks, withSkillBlocks } from "../src/skill-blocks.ts";
import { SKILL_BLOCK_CASES, block } from "./skill-blocks-cases.ts";

// The expected display text and stripped skill names per case — kept here
// because the shared table feeds the Rust comparison vectors too (issue #308).
const EXPECTED: Record<string, { text: string; skills: string[] }> = {
  "no-block": { text: "$review do x", skills: [] },
  "one-block": { text: "$review do x", skills: ["review"] },
  "two-blocks": { text: "run $deploy after $review", skills: ["deploy", "review"] },
  "empty-body": { text: "$review", skills: ["review"] },
  "multiline-text": { text: "$review\nthen\n\n", skills: ["review"] },
  "not-at-start": { text: `see\n\n${block("review", "Steps.")}\n\n$review`, skills: [] },
  "block-only": { text: block("review", "Steps."), skills: [] },
  "block-then-separator-only": { text: `${block("review", "Steps.")}\n\n`, skills: [] },
  "single-newline-separator": { text: `${block("review", "Steps.")}\n$review`, skills: [] },
  unclosed: { text: `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\n\nSteps.\n\n$review`, skills: [] },
  "uppercase-name": { text: `${block("Review", "Steps.")}\n\n$Review`, skills: [] },
  "empty-name": { text: `${block("", "Steps.")}\n\nhi`, skills: [] },
  "missing-references-line": { text: `<skill name="review" location="/s/SKILL.md">\n\nSteps.\n</skill>\n\n$review`, skills: [] },
  "missing-blank-line": { text: `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\nSteps.\n</skill>\n\n$review`, skills: [] },
  "quote-in-location": { text: `<skill name="review" location="/a"b/SKILL.md">\nReferences are relative to /a"b.\n\nSteps.\n</skill>\n\n$review`, skills: [] },
  "leading-space": { text: ` ${block("review", "Steps.")}\n\n$review`, skills: [] },
  "second-block-malformed": { text: `<skill name="x">\n$review`, skills: ["review"] },
  "two-blocks-no-text": { text: block("deploy", "Deploy."), skills: ["review"] },
  unicode: { text: "用 $review 😀", skills: ["review"] },
};

describe("stripSkillBlocks", () => {
  it.each(SKILL_BLOCK_CASES)("$name", ({ name, text }) => {
    expect(stripSkillBlocks(text)).toEqual(EXPECTED[name]);
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
      expect(stripSkillBlocks(withSkillBlocks([deploy, review], text))).toEqual({ text, skills: ["deploy", "review"] });
    }
  });
});
