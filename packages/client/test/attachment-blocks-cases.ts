// Shared inputs for `stripUserBlocks` (issues #308, #321): the skill blocks
// the host prepends and the attachments block it appends, plus near misses
// that must stay in the typed text. Both the TS test and the Rust replay use
// this table. Attachments are only recognized when a whole text block is the
// v1 block — a string or a mixed text block must stay text.
import { attachmentBlock, type AttachmentFile } from "@pinomad/protocol/attachments.ts";

const id = (letter: string): string => letter.repeat(22);

export const attached = (overrides: Partial<AttachmentFile> = {}): AttachmentFile => ({
  id: id("A"),
  name: "notes.txt",
  path: `/home/u/.pinomad/attachments/${id("A")}/file/notes.txt`,
  size: 5,
  ...overrides,
});

export type UserBlockContent = string | readonly { readonly type: string; readonly text?: string }[];

export const textBlock = (text: string): { type: "text"; text: string } => ({ type: "text", text });

const skillThenText = `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\n\nSteps.\n</skill>\n\n$review`;

export const USER_BLOCK_CASES: readonly { readonly name: string; readonly content: UserBlockContent }[] = [
  // The host's shape: separate text blocks, the attachment block last.
  { name: "attachments-only", content: [textBlock(attachmentBlock([attached()]))] },
  {
    name: "text-then-attachments",
    content: [textBlock("look at these"), textBlock(attachmentBlock([attached()]))],
  },
  {
    name: "skills-then-text-then-attachments",
    content: [textBlock(skillThenText), textBlock(attachmentBlock([attached({ name: 'a&b<c>d"e' })])), { type: "image" }],
  },
  {
    name: "two-files",
    content: [
      textBlock("two files"),
      textBlock(attachmentBlock([
        attached(),
        attached({ id: id("B"), name: "second.txt", path: `/data/${id("B")}/file/second.txt`, size: 0 }),
      ])),
    ],
  },
  // Near misses: the block has to be the whole block, not a substring.
  { name: "string-ending-in-block", content: attachmentBlock([attached()]) },
  {
    name: "block-embedded-in-text",
    content: [textBlock(`before ${attachmentBlock([attached()])} after`)],
  },
  { name: "block-not-at-end", content: [textBlock(`${attachmentBlock([attached()])}and typed text`)] },
  {
    name: "malformed-size",
    content: [textBlock(attachmentBlock([attached()]).replace('size="5"', 'size="05"'))],
  },
  { name: "missing-close", content: [textBlock(attachmentBlock([attached()]).replace("</attachments>", ""))] },
  { name: "empty-string", content: "" },
  { name: "empty-array", content: [] },
];
