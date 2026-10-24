// Skill blocks (issue #308, ADR-0028) and attachment blocks (issue #321):
// the host writes more into a `pi.user` message than the user typed. Clients
// show only the typed text, so the writer and its exact inverse live together
// here. The skill parser is a literal scanner, no regex, so the Rust core's
// `skill_blocks.rs` mirrors it step for step.
//
// Attachments are identified by content-block boundaries, never by searching
// joined text: only a whole text block that is exactly the v1 block becomes
// attachments. A string message (or a text block with prose around the block)
// is always regular text.
import {
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

/** A content block as the derivation needs it; other fields ride along untouched. */
export interface UserContentBlock {
  readonly type?: string;
  readonly text?: string;
}

export type UserContent = string | readonly UserContentBlock[];

/** The typed text past every leading skill block, and their names. */
function stripSkillPrefix(text: string): { text: string; skills: string[] } {
  const skills: string[] = [];
  let at = 0;
  for (;;) {
    const end = blockEnd(text, at);
    if (end === -1 || !text.startsWith(SEPARATOR, end) || end + SEPARATOR.length === text.length) {
      return { text: text.slice(at), skills };
    }
    // The name runs from the open tag to its closing quote.
    skills.push(text.slice(at + OPEN.length, text.indexOf('"', at + OPEN.length)));
    at = end + SEPARATOR.length;
  }
}

/**
 * The text the user typed, from a `pi.user` message the host may have
 * prefixed with skill blocks and appended an attachments block to, plus those
 * blocks' contents.
 *
 * One pass over the content: a text block that is exactly a v1 attachments
 * block is consumed as attachments; every other text block joins into the
 * typed text, which is then stripped of leading skill blocks. A string
 * message never carries attachments. Tool results must call their own text
 * extraction, not this function.
 */
export function stripUserBlocks(content: UserContent): UserText {
  const attachments: UserAttachment[] = [];
  let joined = "";
  if (typeof content === "string") {
    joined = content;
  } else {
    for (const block of content) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const files = parseAttachmentBlock(block.text);
      if (files !== undefined) attachments.push(...files);
      else joined += block.text;
    }
  }
  const typed = stripSkillPrefix(joined);
  return { text: typed.text, skills: typed.skills, attachments };
}
