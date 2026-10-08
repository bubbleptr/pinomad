import { describe, expect, it } from "vitest";
import { isClientFrame } from "../src/frames.ts";

// The gateway closes connections that send frames isClientFrame rejects, so
// every call shape the controller emits must be accepted here — and the
// optional protocol-v4 fields must not let malformed values through.
describe("isClientFrame", () => {
  it("accepts createConversation with model and thinkingLevel", () => {
    expect(
      isClientFrame({
        type: "call",
        id: 1,
        method: "createConversation",
        args: {
          home: { kind: "chat" },
          text: "hi",
          requestId: "req",
          model: { provider: "faux", modelId: "faux-1" },
          thinkingLevel: "medium",
        },
      }),
    ).toBe(true);
  });

  it("rejects createConversation with a malformed model or level", () => {
    const base = { home: { kind: "chat" }, text: "hi", requestId: "req" };
    expect(
      isClientFrame({ type: "call", id: 1, method: "createConversation", args: { ...base, model: { provider: "faux" } } }),
    ).toBe(false);
    expect(
      isClientFrame({ type: "call", id: 1, method: "createConversation", args: { ...base, thinkingLevel: 3 } }),
    ).toBe(false);
    expect(
      isClientFrame({ type: "call", id: 1, method: "createConversation", args: { ...base, thinkingLevel: "" } }),
    ).toBe(false);
  });

  it("accepts setThinkingLevel and rejects the removed cycleThinking", () => {
    expect(
      isClientFrame({
        type: "call",
        id: 1,
        method: "setThinkingLevel",
        args: { conversationId: 7, level: "high" },
      }),
    ).toBe(true);
    expect(isClientFrame({ type: "call", id: 1, method: "setThinkingLevel", args: { conversationId: 7 } })).toBe(false);
    expect(isClientFrame({ type: "call", id: 1, method: "cycleThinking", args: { conversationId: 7 } })).toBe(false);
  });
});
