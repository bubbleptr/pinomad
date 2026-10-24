// Shared inputs for `stripUserBlocks` (issue #308, ADR-0028): the leading
// skill blocks the host prepends to a `$name` message, and the near misses
// that must stay untouched. skill-blocks.test.ts pins the expected results;
// rust-vectors.ts serializes the same table for the Rust replay.

/** One block exactly as the host emits it (pi-coding-agent's `/skill:` format). */
export const block = (name: string, body: string, dir = `/home/u/.agents/skills/${name}`): string =>
  `<skill name="${name}" location="${dir}/SKILL.md">\nReferences are relative to ${dir}.\n\n${body}\n</skill>`;

export const SKILL_BLOCK_CASES: readonly { readonly name: string; readonly text: string }[] = [
  { name: "no-block", text: "$review do x" },
  { name: "one-block", text: `${block("review", "Review steps.")}\n\n$review do x` },
  {
    name: "two-blocks",
    text: `${block("deploy", "Deploy steps.")}\n\n${block("review", "Review\n\nsteps.")}\n\nrun $deploy after $review`,
  },
  // The body is trimmed by the host, so an empty one leaves the blank line
  // butting against the close tag.
  { name: "empty-body", text: `${block("review", "")}\n\n$review` },
  // The user's text keeps its own line breaks and a trailing newline.
  { name: "multiline-text", text: `${block("review", "Steps.")}\n\n$review\nthen\n\n` },
  { name: "not-at-start", text: `see\n\n${block("review", "Steps.")}\n\n$review` },
  { name: "block-only", text: block("review", "Steps.") },
  { name: "block-then-separator-only", text: `${block("review", "Steps.")}\n\n` },
  { name: "single-newline-separator", text: `${block("review", "Steps.")}\n$review` },
  { name: "unclosed", text: `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\n\nSteps.\n\n$review` },
  { name: "uppercase-name", text: `${block("Review", "Steps.")}\n\n$Review` },
  { name: "empty-name", text: `${block("", "Steps.")}\n\nhi` },
  { name: "missing-references-line", text: `<skill name="review" location="/s/SKILL.md">\n\nSteps.\n</skill>\n\n$review` },
  { name: "missing-blank-line", text: `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\nSteps.\n</skill>\n\n$review` },
  { name: "quote-in-location", text: `<skill name="review" location="/a"b/SKILL.md">\nReferences are relative to /a"b.\n\nSteps.\n</skill>\n\n$review` },
  { name: "leading-space", text: ` ${block("review", "Steps.")}\n\n$review` },
  // A well-formed first block followed by a malformed one: only the first
  // strips — the rest is what the user typed.
  { name: "second-block-malformed", text: `${block("review", "Steps.")}\n\n<skill name="x">\n$review` },
  // Two blocks with nothing after the second: the second is the user's text.
  { name: "two-blocks-no-text", text: `${block("review", "Steps.")}\n\n${block("deploy", "Deploy.")}` },
  // Base dir and body with non-ASCII; the user text with an astral char.
  { name: "unicode", text: `${block("review", "审查步骤 😀", "/家/skills/review")}\n\n用 $review 😀` },
];
