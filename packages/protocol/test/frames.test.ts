import { describe, expect, it } from "vitest";
import { HOST_STREAM_NAMES, hostStreams, hostSupportsCall, hostSupportsFeature, parseClientFrame } from "../src/frames.ts";

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

  it("accepts a named agent on createConversation; rejects a malformed one", () => {
    const base = { home: { kind: "chat" }, text: "hi", requestId: "req" };
    expect(
      kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, agent: "reviewer" } }),
    ).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, agent: "" } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "createConversation", args: { ...base, agent: 7 } })).toBe("malformed");
  });

  it("accepts listFiles with either scope kind; rejects malformed scopes and queries", () => {
    const call = (args: unknown): unknown => ({ type: "call", id: 1, method: "listFiles", args });
    expect(kinds(call({ scope: { kind: "conversation", conversationId: 7 }, query: "src/" }))).toBe("frame");
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "worktree" }, query: "" }))).toBe("frame");
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "project" }, query: "a" }))).toBe("frame");
    // Unknown extension fields ride along (ADR-0018 §2).
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "project", extra: 1 }, query: "" }))).toBe("frame");

    expect(kinds(call({ scope: { kind: "conversation", conversationId: "7" }, query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "conversation" }, query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "project", path: "/x" }, query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "project", path: "", checkout: "project" }, query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "both" }, query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "root" }, query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: "conversation:7", query: "" }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "conversation", conversationId: 7 } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "conversation", conversationId: 7 }, query: 3 }))).toBe("malformed");
  });

  it("introduces agentConversations and listFiles at minor 10", () => {
    expect(hostSupportsFeature(9, "agentConversations")).toBe(false);
    expect(hostSupportsFeature(10, "agentConversations")).toBe(true);
    expect(hostSupportsCall(9, "listFiles")).toBe(false);
    expect(hostSupportsCall(10, "listFiles")).toBe(true);
  });

  it("accepts listSkills scopes; rejects malformed ones", () => {
    const call = (args: unknown): unknown => ({ type: "call", id: 1, method: "listSkills", args });
    expect(kinds(call({ scope: { kind: "conversation", conversationId: 7 } }))).toBe("frame");
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "worktree" } }))).toBe("frame");
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "project" } }))).toBe("frame");
    expect(kinds(call({ scope: { kind: "chat" } }))).toBe("frame");
    // Unknown extension fields ride along (ADR-0018 §2).
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "project", extra: 1 } }))).toBe("frame");
    expect(kinds(call({ scope: { kind: "chat", extra: 1 } }))).toBe("frame");

    expect(kinds(call({ scope: { kind: "conversation", conversationId: "7" } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "conversation", conversationId: 0 } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "conversation" } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "project", path: "/x" } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "project", path: "", checkout: "project" } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "project", path: "/x", checkout: "both" } }))).toBe("malformed");
    expect(kinds(call({ scope: { kind: "nope" } }))).toBe("malformed");
    expect(kinds(call({ scope: "chat" }))).toBe("malformed");
    expect(kinds(call({}))).toBe("malformed");
  });

  it("introduces listSkills at minor 13", () => {
    expect(hostSupportsCall(12, "listSkills")).toBe(false);
    expect(hostSupportsCall(13, "listSkills")).toBe(true);
  });

  it("accepts withdrawQueued and steerQueued with a positive integer submissionId", () => {
    for (const method of ["withdrawQueued", "steerQueued"] as const) {
      expect(kinds({ type: "call", id: 1, method, args: { conversationId: 7, submissionId: 3 } })).toBe("frame");
      for (const submissionId of [0, -1, 1.5, "3", null, undefined]) {
        expect(kinds({ type: "call", id: 1, method, args: { conversationId: 7, submissionId } })).toBe("malformed");
      }
      expect(kinds({ type: "call", id: 1, method, args: { submissionId: 3 } })).toBe("malformed");
    }
  });

  it("introduces withdrawQueued and steerQueued at minor 14", () => {
    expect(hostSupportsCall(13, "withdrawQueued")).toBe(false);
    expect(hostSupportsCall(14, "withdrawQueued")).toBe(true);
    expect(hostSupportsCall(13, "steerQueued")).toBe(false);
    expect(hostSupportsCall(14, "steerQueued")).toBe(true);
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
    expect(kinds(call({ acceptAccountDevices: false }))).toBe("frame");
    expect(kinds(call({ acceptAccountDevices: null }))).toBe("frame");
    expect(kinds(call({ acceptAccountDevices: "yes" }))).toBe("malformed");
    expect(kinds(call({ defaultThinkingLevel: "xhigh" }))).toBe("frame");
    expect(kinds(call({ custom: [] }))).toBe("malformed");
    expect(kinds(call({ bogus: 1 }))).toBe("malformed");
    expect(kinds(call({ steeringMode: "sometimes" }))).toBe("malformed");
    expect(kinds(call({ defaultThinkingLevel: "ludicrous" }))).toBe("malformed");
    // Inherited keys of the levels record are not levels.
    expect(kinds(call({ defaultThinkingLevel: "constructor" }))).toBe("malformed");
    expect(kinds(call({ defaultThinkingLevel: "__proto__" }))).toBe("malformed");
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

  it("accepts bound skill names on submit and createConversation (5.16), rejects malformed ones", () => {
    const submit = (skills: unknown) =>
      kinds({ type: "call", id: 1, method: "submit", args: { conversationId: 1, text: "$review x", whenBusy: "followUp", requestId: "r", skills } });
    const create = (skills: unknown) =>
      kinds({ type: "call", id: 1, method: "createConversation", args: { home: { kind: "chat" }, text: "$review x", requestId: "r", skills } });
    for (const call of [submit, create]) {
      expect(call(["review", "deploy"])).toBe("frame");
      // An empty list is meaningful: nothing was picked, expand nothing.
      expect(call([])).toBe("frame");
      expect(call(undefined)).toBe("frame");
      expect(call("review")).toBe("malformed");
      expect(call([""])).toBe("malformed");
      expect(call([4])).toBe("malformed");
    }
  });

  it("accepts image refs on submit (5.15); a ref is only a name", () => {
    const submit = (images: unknown) =>
      kinds({ type: "call", id: 1, method: "submit", args: { conversationId: 1, text: "hi", whenBusy: "followUp", requestId: "r", images } });
    expect(submit([{ ref: "abc" }, { data: "aGVsbG8=", mimeType: "image/png" }])).toBe("frame");
    expect(submit([{ ref: "abc", mimeType: "image/png" }])).toBe("frame");
    expect(submit([{ ref: "" }])).toBe("malformed");
    expect(submit([{ ref: 4 }])).toBe("malformed");
    // A data form still needs its type; mixing a bad data field with a ref is malformed.
    expect(submit([{ ref: "abc", data: 4 }])).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "image", args: { ref: "abc" } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "image", args: { ref: "" } })).toBe("malformed");
  });

  it("keeps a subscribe's images: \"ref\" and drops values it doesn't know", () => {
    expect(parseClientFrame({ type: "subscribe", stream: "conversation:3", images: "ref" })).toEqual({
      kind: "frame",
      frame: { type: "subscribe", stream: "conversation:3", images: "ref" },
    });
    // A newer client's form this host predates degrades to inline bytes, not a 4400.
    expect(parseClientFrame({ type: "subscribe", stream: "conversation:3", images: "thumb" })).toEqual({
      kind: "frame",
      frame: { type: "subscribe", stream: "conversation:3" },
    });
  });

  it("accepts a string, APNs object, or null token on setPushToken, rejecting malformed shapes", () => {
    // The legacy string still parses — its refusal is an ok:false answer, not
    // a 4400 (ADR-0025 §7).
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: "ExponentPushToken[abc]" } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: "anything" } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: null } })).toBe("frame");
    // The 5.9 APNs form: hex token + environment; content rules are the host's.
    for (const environment of ["production", "development"]) {
      expect(
        kinds({ type: "call", id: 1, method: "setPushToken", args: { token: { apns: "aa11", environment } } }),
      ).toBe("frame");
    }
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: {} })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: 3 } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: ["x"] } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: { apns: 5, environment: "production" } } })).toBe("malformed");
    expect(kinds({ type: "call", id: 1, method: "setPushToken", args: { token: { apns: "aa11" } } })).toBe("malformed");
    expect(
      kinds({ type: "call", id: 1, method: "setPushToken", args: { token: { apns: "aa11", environment: "sandbox" } } }),
    ).toBe("malformed");
  });

  it("introduces setPushToken at minor 7 and its APNs form at minor 9", () => {
    expect(hostSupportsCall(6, "setPushToken")).toBe(false);
    expect(hostSupportsCall(7, "setPushToken")).toBe(true);
    expect(hostSupportsFeature(8, "apnsPush")).toBe(false);
    expect(hostSupportsFeature(9, "apnsPush")).toBe(true);
  });

  it("introduces the acceptAccountDevices setting at minor 8", () => {
    expect(hostSupportsFeature(7, "acceptAccountDevices")).toBe(false);
    expect(hostSupportsFeature(8, "acceptAccountDevices")).toBe(true);
  });

  it("introduces the agents stream and the three agent calls at minor 6", () => {
    expect(hostStreams(5)).not.toContain("agents");
    expect(hostStreams(6)).toContain("agents");
    for (const method of ["createAgent", "updateAgent", "deleteAgent"] as const) {
      expect(hostSupportsCall(5, method)).toBe(false);
      expect(hostSupportsCall(6, method)).toBe(true);
    }
  });

  it("accepts shaped roles on the agent calls and a name on deleteAgent, rejecting malformed ones", () => {
    const role = { name: "reviewer", description: "Reviews code", prompt: "Look for mistakes." };
    for (const method of ["createAgent", "updateAgent"]) {
      expect(kinds({ type: "call", id: 1, method, args: { role } })).toBe("frame");
      // Optional fields are checked for shape too; content rules are the host's.
      expect(kinds({ type: "call", id: 1, method, args: { role: { ...role, model: "x", thinkingLevel: "y" } } })).toBe("frame");
      expect(kinds({ type: "call", id: 1, method, args: { role: { ...role, name: 1 } } })).toBe("malformed");
      expect(kinds({ type: "call", id: 1, method, args: { role: { ...role, prompt: 1 } } })).toBe("malformed");
      expect(kinds({ type: "call", id: 1, method, args: { role: "x" } })).toBe("malformed");
      expect(kinds({ type: "call", id: 1, method, args: {} })).toBe("malformed");
    }
    expect(kinds({ type: "call", id: 1, method: "deleteAgent", args: { name: "reviewer" } })).toBe("frame");
    expect(kinds({ type: "call", id: 1, method: "deleteAgent", args: { name: 1 } })).toBe("malformed");
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
