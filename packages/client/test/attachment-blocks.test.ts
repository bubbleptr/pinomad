import { describe, expect, it } from "vitest";
import { attachmentBlock } from "@pinomad/protocol/attachments.ts";
import { stripUserBlocks } from "../src/skill-blocks.ts";
import { attached, USER_BLOCK_CASES, textBlock } from "./attachment-blocks-cases.ts";

const byName = (name: string) => USER_BLOCK_CASES.find((c) => c.name === name)!;

describe("stripUserBlocks", () => {
  it("consumes a whole attachments-only text block", () => {
    expect(stripUserBlocks(byName("attachments-only").content)).toEqual({
      text: "",
      skills: [],
      attachments: [{ id: attached().id, name: "notes.txt", size: 5 }],
    });
  });

  it("keeps the typed text in the text block before the attachments block", () => {
    const parsed = stripUserBlocks(byName("text-then-attachments").content);
    expect(parsed.text).toBe("look at these");
    expect(parsed.attachments).toHaveLength(1);
  });

  it("combines skill blocks and an attachments block in one pass", () => {
    const parsed = stripUserBlocks(byName("skills-then-text-then-attachments").content);
    expect(parsed.text).toBe("$review");
    expect(parsed.skills).toEqual(["review"]);
    expect(parsed.attachments).toEqual([{ id: attached().id, name: 'a&b<c>d"e', size: 5 }]);
  });

  it("returns every file in order", () => {
    const parsed = stripUserBlocks(byName("two-files").content);
    expect(parsed.text).toBe("two files");
    expect(parsed.attachments.map((file) => [file.name, file.size])).toEqual([
      ["notes.txt", 5],
      ["second.txt", 0],
    ]);
  });

  it("never treats a string message as attachments", () => {
    const block = attachmentBlock([attached()]);
    expect(stripUserBlocks(block)).toEqual({ text: block, skills: [], attachments: [] });
  });

  it("never strips a block embedded inside a text block", () => {
    const block = attachmentBlock([attached()]);
    for (const content of [byName("block-embedded-in-text").content, [textBlock(`${block} after`)], [textBlock(`before ${block}`)]]) {
      const parsed = stripUserBlocks(content);
      expect(parsed.attachments).toEqual([]);
      expect(parsed.text).toContain("<attachments v=\"1\">");
    }
  });

  it.each(["malformed-size", "missing-close", "block-not-at-end", "empty-string", "empty-array"])(
    "leaves %s untouched",
    (name) => {
      const content = byName(name).content;
      const expected = typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
      expect(stripUserBlocks(content)).toEqual({ text: expected, skills: [], attachments: [] });
    },
  );
});
