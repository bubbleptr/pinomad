// Skill blocks (issue #308, ADR-0028) and attachment blocks (issue #321):
// the host writes more into a `pi.user` message than the user typed. Clients
// show only the typed text, so the writer and its exact inverse live together
// here. The parser is a literal scanner, no regex, so the Rust core's
// `skill_blocks.rs` mirrors it step for step.
import {
  ATTACHMENTS_OPEN,
  parseAttachmentBlock,
  type UserAttachment,
} from "@pinomad/protocol/attachments.ts";

/** One skill as the host expands it. */
export interface SkillBlock {
  readonly name: string;
  /** The SKILL.md path. */
  readonly location: string;
  /** The directory the skill's own references resolve against. */
  readonly baseDir: string;
  /** SKILL.md without frontmatter, trimmed. */
  readonly body: string;
}

const OPEN = '<skill name="';
const LOCATION = '" location="';
const REFERENCES = '">\nReferences are relative to ';
const CLOSE = "\n</skill>";
const SEPARATOR = "\n\n";

/** `blocks` ahead of `text`, each separated by a blank line; `text` alone when there are none. */
export function withSkillBlocks(blocks: readonly SkillBlock[], text: string): string {
  if (blocks.length === 0) return text;
  const written = blocks.map(
    (block) => `${OPEN}${block.name}${LOCATION}${block.location}${REFERENCES}${block.baseDir}.\n\n${block.body}${CLOSE}`,
  );
  return [...written, text].join(SEPARATOR);
}

/** `[a-z0-9-]` — every name a `$` mention can match. */
const isNameUnit = (unit: number): boolean =>
  (unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x7a) || unit === 0x2d;

/** Where the block starting at `at` ends (just past `</skill>`), or -1 when none starts there. */
function blockEnd(text: string, at: number): number {
  if (!text.startsWith(OPEN, at)) return -1;
  let i = at + OPEN.length;
  const name = i;
  while (i < text.length && isNameUnit(text.charCodeAt(i))) i += 1;
  if (i === name || !text.startsWith(LOCATION, i)) return -1;
  i += LOCATION.length;
  const location = i;
  while (i < text.length && text[i] !== '"' && text[i] !== "\n") i += 1;
  if (i === location || !text.startsWith(REFERENCES, i)) return -1;
  i += REFERENCES.length;
  // The references line: a non-empty base dir, a period, then a blank line.
  const lineEnd = text.indexOf("\n", i);
  if (lineEnd - i < 2 || text[lineEnd - 1] !== "." || text[lineEnd + 1] !== "\n") return -1;
  // The body may be empty: the blank line's own newline then opens the close tag.
  const close = text.indexOf(CLOSE, lineEnd + 1);
  return close === -1 ? -1 : close + CLOSE.length;
}

/** A `pi.user` message as the user wrote it, and what the host wrote around it. */
export interface UserText {
  readonly text: string;
  /** The stripped blocks' names, in order — what a bubble highlights and a queued edit restores as chips. */
  readonly skills: readonly string[];
  /** The attachments the host appended, in the order it recorded them. */
  readonly attachments: readonly UserAttachment[];
}

/**
 * The text the user typed, from a `pi.user` message the host may have
 * prefixed with skill blocks and appended an attachments block to, plus those
 * blocks' contents. Strips each well-formed skill block at the start —
 * `<skill name="N" location="L">\nReferences are relative to B.\n\n…\n</skill>`
 * with N in `[a-z0-9-]+`, L non-empty without `"` or a newline, B non-empty,
 * the body ending at the first `\n</skill>` — as long as `\n\n` and a
 * non-empty rest follow it. Then strips one exact v1 attachment block from the
 * end. Anything else, including a block that is not at those positions, is
 * left in the text.
 */
export function stripUserBlocks(text: string): UserText {
  const skills: string[] = [];
  let at = 0;
  for (;;) {
    const end = blockEnd(text, at);
    if (end === -1 || !text.startsWith(SEPARATOR, end) || end + SEPARATOR.length === text.length) break;
    // The name runs from the open tag to its closing quote.
    skills.push(text.slice(at + OPEN.length, text.indexOf('"', at + OPEN.length)));
    at = end + SEPARATOR.length;
  }
  let from = at;
  for (;;) {
    const start = text.indexOf(ATTACHMENTS_OPEN, from);
    if (start === -1) return { text: text.slice(at), skills, attachments: [] };
    const attachments = parseAttachmentBlock(text.slice(start));
    if (attachments !== undefined) return { text: text.slice(at, start), skills, attachments };
    from = start + ATTACHMENTS_OPEN.length;
  }
}

/** The skill-only view the original callers use; attachments are dropped from `text` too. */
export function stripSkillBlocks(text: string): Pick<UserText, "text" | "skills"> {
  const { text: typed, skills } = stripUserBlocks(text);
  return { text: typed, skills };
}
