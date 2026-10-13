import { describe, expect, it } from "vitest";
import { HOST_STREAM_NAMES, parseClientFrame } from "../src/frames.ts";

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

  it("accepts listFolders with or without a path; rejects malformed paths", () => {
    expect(kinds({ type: "call", id: 1, method: "listFolders", args: {} })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "listFolders", args: { path: "/x" } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "listFolders", args: { path: "" } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "listFolders", args: { path: 3 } })).toBe("malformed");
  });

  it("accepts logout with a providerId; rejects a malformed one", () => {
    expect(kinds({ type: "call", id: 1, method: "logout", args: { providerId: "anthropic" } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "logout", args: { providerId: "" } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "logout", args: { providerId: 3 } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "logout", args: {} })).toBe("malformed");
  });

  it("accepts updateSettings patches; rejects unknown keys and bad values", () => {
    const call = (patch: unknown): unknown => ({ type: "call", id: 1, method: "updateSettings", args: { patch } });
    expect(kinds(call({}))).toBe("frame");
    expect(kinds(call({ defaultModel: { provider: "a", modelId: "b" }, steeringMode: "all" }))).toBe("frame");
    expect(kinds(call({ defaultModel: null, defaultThinkingLevel: null, followUpMode: null }))).toBe("frame");
    expect(kinds(call({ defaultThinkingLevel: "xhigh" }))).toBe("frame");
    expect(kinds(call({ custom: [] }))).toBe("malformed");
    expect(kinds(call({ bogus: 1 }))).toBe("malformed");
    expect(kinds(call({ steeringMode: "sometimes" }))).toBe("malformed");
    expect(kinds(call({ defaultThinkingLevel: "ludicrous" }))).toBe("malformed");
    expect(kinds(call({ defaultModel: { provider: "a" } }))).toBe("malformed");
    expect(kinds(call({ defaultModel: "a/b" }))).toBe("malformed");
    expect(kinds(call("x"))).toBe("malformed");
  });

  it("rejects a call without a valid id", () => {
    expect(kinds({ type: "call", method: "abort", args: { conversationId: 1 } })).toBe("malformed");
    expect(kinds({ type: "call", id: "1", method: "abort", args: { conversationId: 1 } })).toBe("malformed");
  });

  it("reports an unknown stream as unsupportedStream", () => {
    expect(parseClientFrame({ type: "subscribe", stream: "settingsx" })).toEqual({
      kind: "unsupportedStream",
      type: "subscribe",
      stream: "settingsx",
    });
    expect(parseClientFrame({ type: "unsubscribe", stream: "settingsx" })).toEqual({
      kind: "unsupportedStream",
      type: "unsubscribe",
      stream: "settingsx",
    });
  });

  it("accepts every host stream and tasks; other bare names stay unsupported", () => {
    for (const stream of [...HOST_STREAM_NAMES, "tasks"]) {
      expect(kinds({ type: "subscribe", stream })).toBe("frame");
    }
    expect(parseClientFrame({ type: "subscribe", stream: "settingsx" })).toEqual({
      kind: "unsupportedStream",
      type: "subscribe",
      stream: "settingsx",
    });
  });

  it("rejects a malformed name under a known stream kind", () => {
    expect(kinds({ type: "subscribe", stream: "conversation:abc" })).toBe("malformed");
    expect(kinds({ type: "subscribe", stream: "doc:plan:abc" })).toBe("malformed");
    expect(kinds({ type: "subscribe", stream: 4 })).toBe("malformed");
    expect(kinds({ type: "subscribe" })).toBe("malformed");
  });


  it("accepts shaped images on submit and createConversation, rejects malformed ones", () => {
    const image = { data: "aGVsbG8=", mimeType: "image/png" };
    expect(
      kinds({ type: "call", id: 1, method: "submit", args: { conversationId: 1, text: "hi", whenBusy: "followUp", requestId: "r", images: [image] } }),
    ).toBe("frame");
    expect(
      kinds({ type: "call", id: 1, method: "submit", args: { conversationId: 1, text: "hi", whenBusy: "followUp", requestId: "r", images: "x" } }),
    ).toBe("malformed");
    expect(
      kinds({ type: "call", id: 1, method: "submit", args: { conversationId: 1, text: "hi", whenBusy: "followUp", requestId: "r", images: [{ data: 1, mimeType: "image/png" }] } }),
    ).toBe("malformed");

    const base = { home: { kind: "chat" }, requestId: "req" };
    // An image-only first message is valid; an empty one is not.
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, text: "", images: [image] } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, text: "", images: [] } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, text: "" } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, text: "hi", images: "x" } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, text: "hi", images: [{ data: "AA==" }] } })).toBe("malformed");
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
