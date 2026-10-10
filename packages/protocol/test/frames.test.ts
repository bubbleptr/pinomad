import { describe, expect, it } from "vitest";
import { parseClientFrame } from "../src/frames.ts";

// The gateway closes connections on "malformed", answers "unsupported*" with
// an error, and ignores "unknownType" (ADR-0018 §3), so every call shape the
// controller emits must parse as a frame — and the optional protocol-v5
// fields must not let malformed values through.
describe("parseClientFrame", () => {
  const kinds = (value: unknown) => parseClientFrame(value).kind;

  it("accepts createConversation with model and thinkingLevel", () => {
    expect(
      parseClientFrame({
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
      }).kind,
    ).toBe("frame");
  });

  it("rejects createConversation with a malformed model or level", () => {
    const base = { home: { kind: "chat" }, text: "hi", requestId: "req" };
    expect(
      kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, model: { provider: "faux" } } }),
    ).toBe("malformed");
    expect(
      kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, thinkingLevel: 3 } }),
    ).toBe("malformed");
    expect(
      kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, thinkingLevel: "" } }),
    ).toBe("malformed");
  });

  it("accepts setThinkingLevel; the removed cycleThinking is an unknown call", () => {
    expect(
      kinds({
        type: "call",
        id: 1,
        method: "setThinkingLevel",
        args: { conversationId: 7, level: "high" },
      }),
    ).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "setThinkingLevel", args: { conversationId: 7 } })).toBe("malformed");
    expect(parseClientFrame({ type: "call", id: 1, method: "cycleThinking", args: { conversationId: 7 } })).toEqual({
      kind: "unsupportedCall",
      id: 1,
      method: "cycleThinking",
    });
  });

  it("reports an unknown method with a valid envelope as unsupportedCall", () => {
    expect(parseClientFrame({ type: "call", id: 9, method: "futureMethod", args: {} })).toEqual({
      kind: "unsupportedCall",
      id: 9,
      method: "futureMethod",
    });
    // The method must still be a string, and args a record, to reach that.
    expect(kinds({ type: "call", id: 9, method: 7, args: {} })).toBe("malformed");
    expect(kinds({ type: "call", id: 9, method: "futureMethod", args: "x" })).toBe("malformed");
  });

  it("rejects a call without a valid id", () => {
    expect(kinds({ type: "call", method: "abort", args: { conversationId: 1 } })).toBe("malformed");
    expect(kinds({ type: "call", id: "1", method: "abort", args: { conversationId: 1 } })).toBe("malformed");
  });

  it("reports an unknown stream as unsupportedStream", () => {
    expect(parseClientFrame({ type: "subscribe", stream: "settings" })).toEqual({
      kind: "unsupportedStream",
      type: "subscribe",
      stream: "settings",
    });
    expect(parseClientFrame({ type: "unsubscribe", stream: "settings" })).toEqual({
      kind: "unsupportedStream",
      type: "unsubscribe",
      stream: "settings",
    });
  });

  it("rejects a malformed name under a known stream kind", () => {
    expect(kinds({ type: "subscribe", stream: "conversation:abc" })).toBe("malformed");
    expect(kinds({ type: "subscribe", stream: "doc:plan:abc" })).toBe("malformed");
    expect(kinds({ type: "subscribe", stream: 4 })).toBe("malformed");
    expect(kinds({ type: "subscribe" })).toBe("malformed");
  });

  it("ignores frames whose type it does not know", () => {
    expect(kinds({ type: "ping" })).toBe("unknownType");
    expect(kinds({ type: "ping", extra: 1 })).toBe("unknownType");
  });

  it("rejects non-objects and frames without a string type", () => {
    expect(kinds(null)).toBe("malformed");
    expect(kinds("subscribe")).toBe("malformed");
    expect(kinds([1, 2])).toBe("malformed");
    expect(kinds({})).toBe("malformed");
    expect(kinds({ type: 4 })).toBe("malformed");
  });
});
