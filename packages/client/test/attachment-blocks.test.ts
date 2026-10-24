import { describe, expect, it } from "vitest";
import { stripUserBlocks } from "../src/skill-blocks.ts";
import { attached, USER_BLOCK_CASES } from "./attachment-blocks-cases.ts";

const byName = (name: string) => USER_BLOCK_CASES.find((c) => c.name === name)!;

describe("stripUserBlocks", () => {
  it("strips an attachments-only block", () => {
    expect(stripUserBlocks(attachment(byName("attachments-only").text))).toEqual({
      text: "",
      skills: [],
      attachments: [{ id: attached().id, name: "notes.txt", size: 5 }],
    });
  });

  it("keeps the typed text before the block", () => {
    const parsed = stripUserBlocks(byName("text-then-attachments").text);
    expect(parsed.text).toBe("look at these");
    expect(parsed.attachments).toHaveLength(1);
  });

  it("combines skill blocks and an attachments block in one pass", () => {
    const parsed = stripUserBlocks(byName("skills-then-text-then-attachments").text);
    expect(parsed.text).toBe("$review");
    expect(parsed.skills).toEqual(["review"]);
    expect(parsed.attachments).toEqual([{ id: attached().id, name: 'a&b<c>d"e', size: 5 }]);
  });

  it("returns every file in order", () => {
    const parsed = stripUserBlocks(byName("two-files").text);
    expect(parsed.text).toBe("two files");
    expect(parsed.attachments.map((file) => [file.name, file.size])).toEqual([
      ["notes.txt", 5],
      ["second.txt", 0],
    ]);
  });

  it.each(["block-not-at-end", "malformed-size", "missing-close", "empty"])(
    "leaves %s untouched",
    (name) => {
      const text = byName(name).text;
      expect(stripUserBlocks(text)).toEqual({ text, skills: [], attachments: [] });
    },
  );
});

/** The whole block string is the case text for attachments-only. */
function attachment(text: string): string {
  return text;
}
