import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENTS_CLOSE,
  ATTACHMENTS_INSTRUCTION,
  MAX_ATTACHMENT_BYTES,
  attachmentBeginProblem,
  attachmentBlock,
  attachmentChunkProblem,
  base64DecodedLength,
  isAttachmentId,
  parseAttachmentBlock,
  xmlAttribute,
} from "../src/attachments.ts";

const ID = "A".repeat(22);
const file = (overrides: Partial<Parameters<typeof attachmentBlock>[0][number]> = {}) => ({
  id: ID,
  name: "notes.txt",
  path: `/data/attachments/${ID}/notes.txt`,
  size: 5,
  ...overrides,
});

describe("attachment values", () => {
  it("validates begin size and chunk base64 before decoding", () => {
    expect(attachmentBeginProblem("a.txt", 0)).toBeUndefined();
    expect(attachmentBeginProblem("a.txt", MAX_ATTACHMENT_BYTES)).toBeUndefined();
    expect(attachmentBeginProblem("", 1)).toMatch(/empty/);
    expect(attachmentBeginProblem("a.txt", -1)).toMatch(/non-negative/);
    expect(attachmentBeginProblem("a.txt", MAX_ATTACHMENT_BYTES + 1)).toMatch(/10 MB/);
    expect(attachmentBeginProblem("a.txt", 1.5)).toMatch(/integer/);

    expect(base64DecodedLength("aGVsbG8=")).toBe(5);
    expect(base64DecodedLength("")).toBe(0);
    expect(base64DecodedLength("abc")).toBeUndefined();
    expect(base64DecodedLength("!!!!")).toBeUndefined();
    expect(attachmentChunkProblem("aGVsbG8=")).toBeUndefined();
    expect(attachmentChunkProblem("!!!!")).toMatch(/base64/);
    const tooBig = "A".repeat(Math.ceil((ATTACHMENT_CHUNK_BYTES + 1) / 3) * 4);
    expect(attachmentChunkProblem(tooBig)).toMatch(/512 KiB/);
  });

  it("accepts only 22-char base64url attachment ids", () => {
    expect(isAttachmentId(ID)).toBe(true);
    expect(isAttachmentId("A".repeat(21))).toBe(false);
    expect(isAttachmentId("../" + "A".repeat(19))).toBe(false);
  });

  it("escapes structural and control characters in every attribute", () => {
    expect(xmlAttribute(`a&b<c>d"e\n\u0001`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#xa;&#x1;");
    const block = attachmentBlock([file({ name: `a&b<c>d"e\n`, path: `/x&y/<z>"q"/` })]);
    expect(block).toContain('name="a&amp;b&lt;c&gt;d&quot;e&#xa;"');
    expect(block).toContain('path="/x&amp;y/&lt;z&gt;&quot;q&quot;/"');
    expect(block.split("\n")[1]).toBe(ATTACHMENTS_INSTRUCTION);
  });

  it("parses its own block back, including escaped names", () => {
    const files = [
      file({ name: `a&b<c>d"e\n` }),
      file({ id: "B".repeat(22), name: "second.txt", size: 0, path: `/data/attachments/${"B".repeat(22)}/second.txt` }),
    ];
    const parsed = parseAttachmentBlock(attachmentBlock(files));
    expect(parsed).toEqual(files.map(({ id, name, size }) => ({ id, name, size })));
  });

  it("rejects blocks that are not the exact v1 shape", () => {
    const good = attachmentBlock([file()]);
    expect(parseAttachmentBlock("x" + good)).toBeUndefined();
    expect(parseAttachmentBlock(good + "\n")).toBeUndefined();
    expect(parseAttachmentBlock(good.replace(ATTACHMENTS_INSTRUCTION, "other"))).toBeUndefined();
    expect(parseAttachmentBlock(good.replace('name="notes.txt"', 'name="notes.txt" extra="x"'))).toBeUndefined();
    expect(parseAttachmentBlock(good.replace('size="5"', 'size="05"'))).toBeUndefined();
    expect(parseAttachmentBlock(good.replace(ID, "short"))).toBeUndefined();
    expect(parseAttachmentBlock(good.replace(ATTACHMENTS_CLOSE, ""))).toBeUndefined();
  });
});
