import { describe, expect, it } from "vitest";
import { composerPlaceholder } from "@/shared/ui/chat/chat-placeholder";

const none = { agents: false, files: false, commands: false, skills: false };

describe("composerPlaceholder", () => {
  it("is just the lead when no trigger works here", () => {
    expect(composerPlaceholder("Ask", none)).toBe("Ask");
  });

  it("shares one @ hint between agents and files", () => {
    expect(composerPlaceholder("Ask", { ...none, agents: true, files: true })).toBe("Ask · @ agent or file");
    expect(composerPlaceholder("Ask", { ...none, files: true })).toBe("Ask · @ file");
  });

  it("drops only the hint whose trigger is missing", () => {
    expect(composerPlaceholder("Ask", { agents: true, files: true, commands: false, skills: true })).toBe(
      "Ask · @ agent or file · $ skill",
    );
  });
});
