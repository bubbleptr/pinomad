// Shared inputs for `stripUserBlocks` (issues #308, #321): the skill blocks
// the host prepends and the attachments block it appends, plus near misses
// that must stay in the typed text. Both the TS test and the Rust replay use
// this table.
import { attachmentBlock, type AttachmentFile } from "@pinomad/protocol/attachments.ts";

const id = (letter: string): string => letter.repeat(22);

export const attached = (overrides: Partial<AttachmentFile> = {}): AttachmentFile => ({
  id: id("A"),
  name: "notes.txt",
  path: `/home/u/.pinomad/attachments/${id("A")}/notes.txt`,
  size: 5,
  ...overrides,
});

export const USER_BLOCK_CASES: readonly { readonly name: string; readonly text: string }[] = [
  { name: "attachments-only", text: attachmentBlock([attached()]) },
  { name: "text-then-attachments", text: `look at these${attachmentBlock([attached()])}` },
  {
    name: "skills-then-text-then-attachments",
    text: `<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\n\nSteps.\n</skill>\n\n$review${attachmentBlock([attached({ name: "a&b<c>d\"e" })])}`,
  },
  {
    name: "two-files",
    text: `two files${attachmentBlock([
      attached(),
      attached({ id: id("B"), name: "second.txt", path: `/data/${id("B")}/second.txt`, size: 0 }),
    ])}`,
  },
  { name: "block-not-at-end", text: `${attachmentBlock([attached()])}and typed text` },
  {
    name: "malformed-size",
    text: attachmentBlock([attached()]).replace('size="5"', 'size="05"'),
  },
  {
    name: "missing-close",
    text: attachmentBlock([attached()]).replace("</attachments>", ""),
  },
  {
    name: "empty",
    text: "",
  },
];
