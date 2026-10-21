import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { INVALID_FRAME_CLOSE_CODE, PROTOCOL, UNAUTHORIZED_CLOSE_CODE, type ClientFrame, type ServerFrame, type StreamName } from "../src/frames.ts";
import { connectRemoteDurable, type RemoteDurable } from "../src/remote-durable.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "../src/transport.ts";
import type { ConversationDefaults, DurableView } from "../src/view.ts";

const SNAPSHOTS: Record<string, unknown> = {
  conversations: [],
  index: { projects: [], conversations: [] },
  devices: { devices: [] },
  tasks: { tasks: {} },
  mcp: null,
  models: [{ provider: "streamp", modelId: "stream-1", name: "Stream One", contextWindow: 8000, thinkingLevels: ["off"] }],
  auth: { logins: [{ providerId: "streamp", name: "Stream Provider", kind: "api_key", subscription: false }] },
  settings: {
    defaultModel: { provider: "streamp", modelId: "stream-1" },
    defaultThinkingLevel: "high",
    steeringMode: "all",
    followUpMode: "all",
    hostName: "Testbox",
    custom: ["defaultModel", "defaultThinkingLevel", "steeringMode", "followUpMode"],
  },
  agents: { roles: [], problems: [] },
};

const id = (n: number): ConversationId => n as ConversationId;

/** A doc kind the fake's hello advertises, so conversations have doc streams too. */
const DOC = { kind: "pinomad.question", presentation: "pinomad.question" as const };

function snapshotFor(stream: string): unknown {
  if (stream in SNAPSHOTS) return SNAPSHOTS[stream];
  // A minimal ConversationView; the client only stores and re-reads it.
  if (stream.startsWith("conversation:")) return { conversation: { id: Number(stream.slice("conversation:".length)) }, entries: [] };
  if (stream.startsWith("doc:")) return { requests: [] };
  return null;
}

/**
 * A transport that answers every subscribe with a snapshot (per-conversation
 * and doc streams included), answers calls ok, records every client frame in
 * `sent`, and says hello with `defaultsList[n]` for connection n (last repeats).
 * `disconnect()` closes the latest connection server-side so the client
 * reconnects.
 */
function fakeTransport(
  defaultsList: readonly ConversationDefaults[],
  helloExtras?: Record<string, unknown>,
  /** Per-call result override; absent answers every call ok. */
  callAnswer?: (frame: Extract<ClientFrame, { type: "call" }>) => { ok: true; value: unknown } | { ok: false; error: string } | undefined,
): {
  transport: FrameTransport;
  opened: FrameHandlers[];
  sent: ClientFrame[];
  disconnect: () => void;
  /** Subscribes to a held stream get no snapshot until `release` sends one. */
  hold: (stream: StreamName) => void;
  release: (stream: StreamName, value: unknown) => void;
  /** Calls to a held method are recorded but never answered. */
  holdCall: (method: string) => void;
} {
  const opened: FrameHandlers[] = [];
  const sent: ClientFrame[] = [];
  const held = new Set<StreamName>();
  const heldCalls = new Set<string>();
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      opened.push(handlers);
      const defaults = defaultsList[Math.min(opened.length - 1, defaultsList.length - 1)]!;
      const hello = {
        type: "hello",
        protocol: PROTOCOL,
        session: { id: "fake", directory: "" },
        models: [],
        docs: [DOC],
        toolPresentations: {},
        defaults,
        ...helloExtras,
      };
      queueMicrotask(() => handlers.message(JSON.stringify(hello)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          sent.push(frame);
          if (frame.type === "subscribe") {
            if (held.has(frame.stream)) return;
            const snapshot: ServerFrame = { type: "snapshot", stream: frame.stream, value: snapshotFor(frame.stream) };
            queueMicrotask(() => handlers.message(JSON.stringify(snapshot)));
          } else if (frame.type === "call") {
            // A hung call is recorded but never answers — the client keeps it pending.
            if (heldCalls.has(frame.method)) return;
            // Fork creates a new conversation; every other call resolves void.
            const value =
              frame.method === "fork"
                ? { conversationId: (frame.args as { conversationId: number }).conversationId + 1 }
                : undefined;
            const answer = callAnswer?.(frame) ?? { ok: true as const, value };
            const result: ServerFrame =
              answer.ok === true
                ? { type: "result", id: frame.id, ok: true, value: answer.value }
                : { type: "result", id: frame.id, ok: false, error: answer.error };
            queueMicrotask(() => handlers.message(JSON.stringify(result)));
          }
        },
        close() {
          queueMicrotask(() => handlers.closed(1000));
        },
      };
    },
  };
  return {
    transport,
    opened,
    sent,
    disconnect: () => opened.at(-1)?.closed(1000),
    hold: (stream) => {
      held.add(stream);
    },
    release: (stream, value) => {
      const snapshot: ServerFrame = { type: "snapshot", stream, value };
      queueMicrotask(() => opened.at(-1)?.message(JSON.stringify(snapshot)));
    },
    holdCall: (method) => {
      heldCalls.add(method);
    },
  };
}

function waitForView(remote: RemoteDurable, predicate: (view: DurableView) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("view condition not met within 5s"));
    }, 5000);
    const unsubscribe = remote.view.subscribe(() => {
      if (predicate(remote.view.current())) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
    if (predicate(remote.view.current())) {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

describe("RemoteDurable reconnect", () => {
  it("applies the reconnect hello's defaults over the first hello's", async () => {
    const second: ConversationDefaults = {
      model: { provider: "faux", modelId: "faux-2" },
      thinkingLevel: "low",
    };
    // A 5.1 host has no `settings` stream — hello.defaults is the source there.
    const { transport, disconnect } = fakeTransport([{}, second], { protocol: { major: PROTOCOL.major, minor: 1 } });
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await waitForView(remote, (view) => view.connection === "connected");
      expect(remote.view.current().defaults).toEqual({});

      disconnect();
      await waitForView(
        remote,
        (view) => view.defaults.model?.modelId === "faux-2" && view.defaults.thinkingLevel === "low",
      );
    } finally {
      remote.close();
    }
  });

  it("ignores frames of a type it does not know and keeps applying later ones", async () => {
    const { transport, opened } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport });
    try {
      // A newer host may send frame types this bundle predates (ADR-0018 §4);
      // they must not break the stream handling around them.
      opened[0]!.message(JSON.stringify({ type: "from-the-future", data: 1 }));
      opened[0]!.message(JSON.stringify({ type: "snapshot", stream: "mcp", value: { servers: [] } }));
      await waitForView(remote, (view) => view.mcp !== null);
      expect(remote.view.current().connection).toBe("connected");
      expect(remote.view.current().mcp).toEqual({ servers: [] });
    } finally {
      remote.close();
    }
  });

  it("treats a 4400 close after ready as terminal: closed, noticed, no reconnect", async () => {
    const { transport, opened } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 10, max: 10 } });
    try {
      opened[0]!.closed(INVALID_FRAME_CLOSE_CODE, "Invalid client frame");
      await waitForView(remote, (view) => view.connection === "closed");
      expect(remote.view.current().notices.at(-1)).toMatchObject({
        level: "error",
        message: expect.stringContaining("malformed"),
      });
      expect(remote.view.current().notices.at(-1)!.message).toContain("Invalid client frame");
      // Reconnecting would loop on the same rejection; give it room to fire.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(opened).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("reconnects after a plain 1008 close: secure-channel failures are not terminal", async () => {
    const { transport, opened } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 10, max: 10 } });
    try {
      opened[0]!.closed(1008, "handshake timeout");
      await waitForView(remote, (view) => view.connection === "reconnecting");
      await waitForView(remote, (view) => view.connection === "connected");
      expect(opened).toHaveLength(2);
    } finally {
      remote.close();
    }
  });

  it("flags a post-ready 4401 close as unauthorized; a 4400 close is not", async () => {
    // The distinction decides the UI: 4401 shows the revoked-pairing screen,
    // 4400 must fall through to the plain disconnect banner and its notice.
    for (const [code, unauthorized] of [
      [UNAUTHORIZED_CLOSE_CODE, true],
      [INVALID_FRAME_CLOSE_CODE, undefined],
    ] as const) {
      const { transport, opened } = fakeTransport([{}]);
      const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 10, max: 10 } });
      try {
        opened[0]!.closed(code);
        await waitForView(remote, (view) => view.connection === "closed");
        expect(remote.view.current().unauthorized).toBe(unauthorized);
      } finally {
        remote.close();
      }
    }
  });
});

describe("RemoteDurable side conversation", () => {
  const subscribes = (sent: readonly ClientFrame[]): string[] =>
    sent.flatMap((frame) => (frame.type === "subscribe" ? [frame.stream] : []));
  const unsubscribes = (sent: readonly ClientFrame[]): string[] =>
    sent.flatMap((frame) => (frame.type === "unsubscribe" ? [frame.stream] : []));

  it("shows a second conversation beside the main one and closes it", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.showSide(id(2));

      expect(subscribes(sent)).toContain("conversation:2");
      expect(subscribes(sent)).toContain(`doc:${DOC.kind}:2`);
      const view = remote.view.current();
      expect(view.side?.id).toBe(id(2));
      expect((view.side?.conversation as { conversation: { id: number } }).conversation.id).toBe(2);
      expect(view.side?.docs.map((doc) => doc.kind)).toEqual([DOC.kind]);
      // The main conversation is untouched.
      expect((view.conversation as { conversation: { id: number } }).conversation.id).toBe(1);
      expect(view.docs.map((doc) => doc.kind)).toEqual([DOC.kind]);

      await remote.controller.showSide(undefined);
      expect(unsubscribes(sent)).toContain("conversation:2");
      expect(unsubscribes(sent)).toContain(`doc:${DOC.kind}:2`);
      expect(remote.view.current().side).toBeUndefined();
    } finally {
      remote.close();
    }
  });

  it("shares streams between the main and side slots without double-subscribing", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      const subscribed = subscribes(sent).length;
      // The side may be the main conversation: nothing new to subscribe.
      await remote.controller.showSide(id(1));
      expect(subscribes(sent)).toHaveLength(subscribed);
      expect(remote.view.current().side?.id).toBe(id(1));
      // Closing it keeps the main's streams and conversation.
      await remote.controller.showSide(undefined);
      expect(unsubscribes(sent)).toHaveLength(0);
      expect((remote.view.current().conversation as { conversation: { id: number } }).conversation.id).toBe(1);
    } finally {
      remote.close();
    }
  });

  it("keeps the side's streams when the main switches onto and away from it", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.showSide(id(2));
      // Switching onto the side's conversation shares its streams.
      const subscribed = subscribes(sent).length;
      await remote.controller.switchConversation(id(2));
      expect(subscribes(sent)).toHaveLength(subscribed);
      // Switching away does not unsubscribe the streams the side still needs.
      await remote.controller.switchConversation(id(3));
      expect(unsubscribes(sent)).not.toContain("conversation:2");
      expect(unsubscribes(sent)).not.toContain(`doc:${DOC.kind}:2`);
      const view = remote.view.current();
      expect(view.side?.id).toBe(id(2));
      expect((view.side?.conversation as { conversation: { id: number } }).conversation.id).toBe(2);
      // The previous main's streams were released.
      expect(unsubscribes(sent)).toContain("conversation:1");
    } finally {
      remote.close();
    }
  });

  it("targets submit, answer and abort at a chosen conversation", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.submit("to the side", "followUp", { target: id(2) });
      await remote.controller.answer(DOC.kind, "req-1", [{ selected: ["yes"] }], id(2));
      await remote.controller.abort(id(2));
      await remote.controller.submit("to the main", "followUp");
      const calls = sent.flatMap((frame) => (frame.type === "call" ? [frame] : []));
      expect(calls.map((frame) => frame.method)).toEqual(["submit", "answer", "abort", "submit"]);
      expect(calls.map((frame) => (frame.args as { conversationId: number }).conversationId)).toEqual([2, 2, 2, 1]);
    } finally {
      remote.close();
    }
  });

  it("returns the host's queued outcomes and targets the shown conversation by default", async () => {
    const answers: Record<string, string> = { withdrawQueued: "withdrawn", steerQueued: "steered" };
    const { transport, sent } = fakeTransport([{}], {}, (frame) =>
      frame.method === "withdrawQueued" || frame.method === "steerQueued"
        ? { ok: true, value: { outcome: answers[frame.method] } }
        : undefined,
    );
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      expect(await remote.controller.withdrawQueued(3)).toBe("withdrawn");
      expect(await remote.controller.steerQueued(4, id(2))).toBe("steered");
      const calls = sent.flatMap((frame) => (frame.type === "call" ? [frame] : []));
      expect(calls.map((frame) => [frame.method, frame.args])).toEqual([
        ["withdrawQueued", { conversationId: 1, submissionId: 3 }],
        ["steerQueued", { conversationId: 2, submissionId: 4 }],
      ]);
      expect(remote.view.current().notices).toEqual([]);
    } finally {
      remote.close();
    }
  });

  it("rejects withdrawQueued with the host's error instead of a notice", async () => {
    const { transport } = fakeTransport([{}], {}, (frame) =>
      frame.method === "withdrawQueued" ? { ok: false, error: "Submission 9 does not exist" } : undefined,
    );
    const remote = await connectRemoteDurable({ transport });
    try {
      await expect(remote.controller.withdrawQueued(9, id(1))).rejects.toThrow("Submission 9 does not exist");
      expect(remote.view.current().notices).toEqual([]);
    } finally {
      remote.close();
    }
  });

  it("rejects both queued calls on a 5.13 host without sending a frame", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 13 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      await expect(remote.controller.withdrawQueued(3, id(1))).rejects.toThrow("needs protocol 5.14");
      await expect(remote.controller.steerQueued(3, id(1))).rejects.toThrow("pinomad upgrade");
      expect(sent.some((frame) => frame.type === "call")).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("sends the caller's requestId on submit, generating a fresh one otherwise", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.submit("retry", "followUp", { target: id(1), requestId: "retry:run-4" });
      await remote.controller.submit("fresh", "followUp", { target: id(1) });
      const submits = sent.filter((frame) => frame.type === "call" && frame.method === "submit");
      expect((submits[0]!.args as { requestId: string }).requestId).toBe("retry:run-4");
      const generated = (submits[1]!.args as { requestId: string }).requestId;
      expect(typeof generated).toBe("string");
      expect(generated.length).toBeGreaterThan(0);
      expect(generated).not.toBe("retry:run-4");
    } finally {
      remote.close();
    }
  });

  it("sends submit images on a 5.5 host, notices and skips the call on 5.4", async () => {
    const image = { data: "aGVsbG8=", mimeType: "image/png" as const };

    const old = fakeTransport([{}], { protocol: { major: 5, minor: 4 } });
    const remoteOld = await connectRemoteDurable({ transport: old.transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remoteOld.controller.switchConversation(id(1));
      await remoteOld.controller.submit("look", "followUp", { images: [image] });
      await waitForView(remoteOld, (view) =>
        view.notices.some(
          (notice) => notice.level === "error" && notice.message.includes("needs protocol 5.5"),
        ),
      );
      expect(old.sent.filter((frame) => frame.type === "call" && frame.method === "submit")).toHaveLength(0);
    } finally {
      remoteOld.close();
    }

    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.submit("look", "followUp", { images: [image] });
      await remote.controller.submit("plain", "followUp");
      const submits = sent.filter((frame) => frame.type === "call" && frame.method === "submit");
      expect((submits[0]!.args as { images: unknown }).images).toEqual([image]);
      // No images option → no `images` key on the wire.
      expect("images" in (submits[1]!.args as object)).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("rejects renameConversation against a 5.3 host and sends it on 5.4", async () => {
    const old = fakeTransport([{}], { protocol: { major: 5, minor: 3 } });
    const remoteOld = await connectRemoteDurable({ transport: old.transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remoteOld.controller.switchConversation(id(1));
      await expect(remoteOld.controller.renameConversation(id(1), "renamed")).rejects.toThrow(
        "The host is too old for this (needs protocol 5.4)",
      );
      expect(old.sent.filter((frame) => frame.type === "call" && frame.method === "renameConversation")).toHaveLength(0);
    } finally {
      remoteOld.close();
    }

    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.renameConversation(id(1), "renamed");
      const call = sent.find((frame) => frame.type === "call" && frame.method === "renameConversation")!;
      expect(call.args).toEqual({ conversationId: 1, title: "renamed" });
    } finally {
      remote.close();
    }
  });

  it("rejects setPushToken against a 5.6 host without sending, sends it on 5.7", async () => {
    const old = fakeTransport([{}], { protocol: { major: 5, minor: 6 } });
    const remoteOld = await connectRemoteDurable({ transport: old.transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await expect(remoteOld.controller.setPushToken("ExponentPushToken[abc]")).rejects.toThrow(
        "The host is too old for this (needs protocol 5.7)",
      );
      expect(old.sent.filter((frame) => frame.type === "call" && frame.method === "setPushToken")).toHaveLength(0);
    } finally {
      remoteOld.close();
    }

    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.setPushToken("ExponentPushToken[abc]");
      await remote.controller.setPushToken(null);
      const calls = sent.filter((frame) => frame.type === "call" && frame.method === "setPushToken");
      expect(calls.map((frame) => frame.args)).toEqual([{ token: "ExponentPushToken[abc]" }, { token: null }]);
    } finally {
      remote.close();
    }
  });

  it("gates the APNs token form on a 5.9 host — a 5.8 host would 4400 it", async () => {
    const apns = { apns: "aa".repeat(32), environment: "production" as const };
    const old = fakeTransport([{}], { protocol: { major: 5, minor: 8 } });
    const remoteOld = await connectRemoteDurable({ transport: old.transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await expect(remoteOld.controller.setPushToken(apns)).rejects.toThrow(
        "The host is too old for this (needs protocol 5.9)",
      );
      expect(old.sent.filter((frame) => frame.type === "call" && frame.method === "setPushToken")).toHaveLength(0);
      // The string form still goes through on the same 5.8 host.
      await remoteOld.controller.setPushToken("ExponentPushToken[abc]");
      expect(old.sent.some((frame) => frame.type === "call" && frame.method === "setPushToken")).toBe(true);
    } finally {
      remoteOld.close();
    }

    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.setPushToken(apns);
      const calls = sent.filter((frame) => frame.type === "call" && frame.method === "setPushToken");
      expect(calls.map((frame) => frame.args)).toEqual([{ token: apns }]);
    } finally {
      remote.close();
    }
  });

  it("rejects setPushToken with the host's error instead of a notice", async () => {
    const { transport } = fakeTransport([{}], {}, (frame) =>
      frame.method === "setPushToken" ? { ok: false, error: "Push tokens register over the secure channel only" } : undefined,
    );
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      // A failed call must surface to the caller, not the notice list.
      await expect(remote.controller.setPushToken("ExponentPushToken[abc]")).rejects.toThrow(
        "Push tokens register over the secure channel only",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(remote.view.current().notices).toHaveLength(0);
    } finally {
      remote.close();
    }
  });

  it("forks into the side panel when asked instead of switching the main", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      // The fake answers the fork call with the new conversation's id.
      await remote.controller.fork("9", "continue here", undefined, { show: "side" });
      const forkCall = sent.find((frame) => frame.type === "call" && frame.method === "fork")!;
      const forked = (forkCall.args as { conversationId: number }).conversationId + 1;
      expect(remote.view.current().side?.id).toBe(id(forked));
      expect(remote.view.current().side?.conversation).not.toBeUndefined();
      // The main conversation is untouched.
      expect((remote.view.current().conversation as { conversation: { id: number } }).conversation.id).toBe(1);
      // The prompt submitted to the fork, not the main.
      const submitCall = sent.find((frame) => frame.type === "call" && frame.method === "submit")!;
      expect((submitCall.args as { conversationId: number }).conversationId).toBe(forked);
    } finally {
      remote.close();
    }
  });

  it("resubscribes the side's streams after a reconnect", async () => {
    const { transport, sent, disconnect } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.switchConversation(id(1));
      await remote.controller.showSide(id(2));
      const before = subscribes(sent).length;

      disconnect();
      await waitForView(remote, (view) => view.connection === "connected" && subscribes(sent).length > before);
      expect(subscribes(sent).slice(before)).toEqual(
        expect.arrayContaining(["conversation:2", `doc:${DOC.kind}:2`]),
      );
      await waitForView(remote, (view) => view.side?.conversation !== undefined);
      expect((remote.view.current().side?.conversation as { conversation: { id: number } }).conversation.id).toBe(2);
    } finally {
      remote.close();
    }
  });
it("closes the side when the archive removes it or its root", async () => {
    const previous = SNAPSHOTS.conversations;
    SNAPSHOTS.conversations = [
      { id: 1, kind: "conversation" },
      { id: 2, kind: "fork", parent: 1 },
      { id: 3, kind: "conversation" },
    ];
    const { transport } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport });
    try {
      await remote.controller.switchConversation(id(3));
      await remote.controller.showSide(id(2));
      // Archiving an unrelated conversation leaves the side alone.
      await remote.controller.archive(id(3), true);
      expect(remote.view.current().side?.id).toBe(id(2));
      // Archiving the side's own root drops the side too — the fork went with it.
      await remote.controller.archive(id(1), true);
      expect(remote.view.current().side).toBeUndefined();
    } finally {
      SNAPSHOTS.conversations = previous;
      remote.close();
    }
  });

  it("waits for a shared stream's fresh snapshot when switching onto it after reconnect", async () => {
    const { transport, hold, release, disconnect } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.showSide(id(2));
      expect((remote.view.current().side?.conversation as { conversation: { id: number } }).conversation.id).toBe(2);

      // Reconnect with conversation:2's fresh snapshot held back: the stream
      // stays wanted for the side but its value is stale until the host answers.
      hold("conversation:2" as StreamName);
      disconnect();
      await waitForView(remote, (view) => view.connection === "connected");

      const switching = remote.controller.switchConversation(id(2));
      await expect(
        Promise.race([switching.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]),
      ).resolves.toBe("pending");

      release("conversation:2" as StreamName, { conversation: { id: 2, marker: "new" }, entries: [] });
      await switching;
      const main = remote.view.current().conversation as { conversation: { id: number; marker?: string } };
      expect(main.conversation.id).toBe(2);
      expect(main.conversation.marker).toBe("new");
    } finally {
      remote.close();
    }
  });
});

describe("RemoteDurable minor-version gating", () => {
  const subscribes = (sent: readonly ClientFrame[]): string[] =>
    sent.flatMap((frame) => (frame.type === "subscribe" ? [frame.stream] : []));

  it("never subscribes to models/auth on a 5.0 host: auth is null, models comes from the hello", async () => {
    const helloModel = { provider: "hp", modelId: "h-1", name: "Hello One", contextWindow: 8000, thinkingLevels: ["off"] };
    const { transport, sent } = fakeTransport([{}], {
      protocol: { major: PROTOCOL.major, minor: 0 },
      models: [helloModel],
    });
    const remote = await connectRemoteDurable({ transport });
    try {
      expect(subscribes(sent)).not.toContain("models");
      expect(subscribes(sent)).not.toContain("auth");
      const view = remote.view.current();
      expect(view.connection).toBe("connected");
      expect(view.models).toEqual([helloModel]);
      expect(view.auth).toBeNull();
    } finally {
      remote.close();
    }
  });

  it("subscribes to models/auth on a 5.1 host; the stream value wins over the hello's models", async () => {
    const { transport, sent, release } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport });
    try {
      expect(subscribes(sent)).toContain("models");
      expect(subscribes(sent)).toContain("auth");
      // hello.models is [] — the stream's snapshot must be what the view shows.
      expect(remote.view.current().models).toEqual(SNAPSHOTS.models);
      expect(remote.view.current().auth).toEqual(SNAPSHOTS.auth);

      const updated = [{ provider: "p2", modelId: "m-2", name: "Two", contextWindow: 1, thinkingLevels: ["off"] }];
      release("models", updated);
      release("auth", { logins: [] });
      await waitForView(remote, (view) => view.models[0]?.provider === "p2" && view.auth?.logins.length === 0);
    } finally {
      remote.close();
    }
  });

  it("logout against a 5.0 host sends nothing and surfaces the upgrade notice", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 0 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      await remote.controller.logout("streamp");
      expect(sent.some((frame) => frame.type === "call" && frame.method === "logout")).toBe(false);
      await waitForView(remote, (view) =>
        view.notices.some(
          (notice) => notice.level === "error" && notice.message.includes("pinomad upgrade"),
        ),
      );
    } finally {
      remote.close();
    }
  });

  it("never subscribes to settings on a 5.1 host: settings is null, defaults come from the hello", async () => {
    const { transport, sent } = fakeTransport([{ model: { provider: "hp", modelId: "h-1" } }], {
      protocol: { major: PROTOCOL.major, minor: 1 },
    });
    const remote = await connectRemoteDurable({ transport });
    try {
      expect(subscribes(sent)).not.toContain("settings");
      const view = remote.view.current();
      expect(view.connection).toBe("connected");
      expect(view.settings).toBeNull();
      expect(view.defaults).toEqual({ model: { provider: "hp", modelId: "h-1" } });

      await remote.controller.updateSettings({ defaultThinkingLevel: "high" });
      expect(sent.some((frame) => frame.type === "call" && frame.method === "updateSettings")).toBe(false);
      await waitForView(remote, (v) =>
        v.notices.some(
          (notice) => notice.level === "error" && notice.message.includes("needs protocol 5.2"),
        ),
      );
    } finally {
      remote.close();
    }
  });

  it("listFolders against a 5.2 host rejects with the upgrade message and sends no frame", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 2 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      await expect(remote.controller.listFolders()).rejects.toThrow("needs protocol 5.3");
      await expect(remote.controller.listFolders("/x")).rejects.toThrow("pinomad upgrade");
      expect(sent.some((frame) => frame.type === "call" && frame.method === "listFolders")).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("sends acceptAccountDevices on a 5.8 host, notices and skips the call on 5.7", async () => {
    // A 5.2–5.7 host would call the unknown patch key malformed and close 4400 —
    // the client must refuse locally instead (ADR-0018 §2).
    const old = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 7 } });
    const remoteOld = await connectRemoteDurable({ transport: old.transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remoteOld.controller.updateSettings({ acceptAccountDevices: false });
      await waitForView(remoteOld, (view) =>
        view.notices.some((notice) => notice.level === "error" && notice.message.includes("needs protocol 5.8")),
      );
      expect(old.sent.filter((frame) => frame.type === "call" && frame.method === "updateSettings")).toHaveLength(0);
      // Keys the host knows still go through on the same connection.
      await remoteOld.controller.updateSettings({ steeringMode: "all" });
      expect(old.sent.some((frame) => frame.type === "call" && frame.method === "updateSettings")).toBe(true);
    } finally {
      remoteOld.close();
    }

    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.updateSettings({ acceptAccountDevices: false });
      const call = sent.find((frame) => frame.type === "call" && frame.method === "updateSettings")!;
      expect(call.args).toEqual({ patch: { acceptAccountDevices: false } });
    } finally {
      remote.close();
    }
  });

  it("sends hostName on a 5.12 host, notices and skips the call on 5.11", async () => {
    // A pre-5.12 host would call the unknown patch key malformed and close
    // 4400 — refuse locally instead, even for the `null` reset (ADR-0018 §2).
    const old = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 11 } });
    const remoteOld = await connectRemoteDurable({ transport: old.transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remoteOld.controller.updateSettings({ hostName: "Desk" });
      await waitForView(remoteOld, (view) =>
        view.notices.some((notice) => notice.level === "error" && notice.message.includes("needs protocol 5.12")),
      );
      await remoteOld.controller.updateSettings({ hostName: null });
      expect(old.sent.filter((frame) => frame.type === "call" && frame.method === "updateSettings")).toHaveLength(0);
      // Keys the host knows still go through on the same connection.
      await remoteOld.controller.updateSettings({ steeringMode: "all" });
      expect(old.sent.some((frame) => frame.type === "call" && frame.method === "updateSettings")).toBe(true);
    } finally {
      remoteOld.close();
    }

    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport, reconnectDelayMs: { min: 20, max: 20 } });
    try {
      await remote.controller.updateSettings({ hostName: "Desk" });
      const call = sent.find((frame) => frame.type === "call" && frame.method === "updateSettings")!;
      expect(call.args).toEqual({ patch: { hostName: "Desk" } });
    } finally {
      remote.close();
    }
  });

  it("subscribes to settings on a 5.2 host; the stream value derives defaults over the hello's", async () => {
    const { transport, sent, release } = fakeTransport([{ model: { provider: "hp", modelId: "h-1" } }]);
    const remote = await connectRemoteDurable({ transport });
    try {
      expect(subscribes(sent)).toContain("settings");
      const view = remote.view.current();
      expect(view.settings).toEqual(SNAPSHOTS.settings);
      // hello.defaults has the hp model — the stream's values must win.
      expect(view.defaults).toEqual({ model: { provider: "streamp", modelId: "stream-1" }, thinkingLevel: "high" });

      release("settings", {
        defaultModel: null,
        defaultThinkingLevel: "low",
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        custom: ["defaultThinkingLevel"],
      });
      await waitForView(remote, (v) => v.defaults.thinkingLevel === "low" && v.defaults.model === undefined);
    } finally {
      remote.close();
    }
  });

  it("createConversation with an agent on a 5.9 host notices the upgrade message and sends no frame", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 9 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      await remote.controller.createConversation({ kind: "chat" }, "hi", { agent: "reviewer" });
      await waitForView(remote, (view) =>
        view.notices.some((notice) => notice.level === "error" && notice.message.includes("needs protocol 5.10")),
      );
      expect(sent.some((frame) => frame.type === "call" && frame.method === "createConversation")).toBe(false);
      // Without the field the same call still goes through on a 5.9 host.
      await remote.controller.createConversation({ kind: "chat" }, "hi");
      const call = sent.find((frame) => frame.type === "call" && frame.method === "createConversation");
      expect(call).toBeDefined();
      expect((call!.args as { agent?: string }).agent).toBeUndefined();
    } finally {
      remote.close();
    }
  });

  it("createConversation carries the agent field on a 5.10 host", async () => {
    const { transport, sent } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport });
    try {
      await remote.controller.createConversation({ kind: "chat" }, "hi", { agent: "reviewer" });
      const call = sent.find((frame) => frame.type === "call" && frame.method === "createConversation")!;
      expect((call.args as { agent?: string }).agent).toBe("reviewer");
    } finally {
      remote.close();
    }
  });

  it("listFiles on a 5.9 host rejects locally with the upgrade message", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 9 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      await expect(
        remote.controller.listFiles({ kind: "conversation", conversationId: id(7) }, "src"),
      ).rejects.toThrow("needs protocol 5.10");
      expect(sent.some((frame) => frame.type === "call" && frame.method === "listFiles")).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("listFiles is not queued behind a hanging command", async () => {
    // The hung archive holds the command queue — listFiles is a read-only
    // request and must still go out and resolve (issue #138).
    const { transport, sent, holdCall } = fakeTransport([{}], {}, (frame) =>
      frame.method === "listFiles" ? { ok: true, value: { files: ["src/a.ts"], truncated: false } } : undefined,
    );
    holdCall("archive");
    const remote = await connectRemoteDurable({ transport });
    try {
      const hanging = remote.controller.archive(id(1), true);
      // A tick so archive's op has run: its call frame is in flight, unanswered.
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent.some((frame) => frame.type === "call" && frame.method === "archive")).toBe(true);
      const answer = await remote.controller.listFiles({ kind: "conversation", conversationId: id(7) }, "src");
      expect(answer).toEqual({ files: ["src/a.ts"], truncated: false });
      const calls = sent.filter((frame) => frame.type === "call");
      expect(calls.map((frame) => frame.method)).toEqual(["archive", "listFiles"]);
      remote.close();
      // close() fails the pending archive call — the command resolves into a notice.
      await hanging;
    } finally {
      remote.close();
    }
  });

  it("listSkills on a 5.12 host rejects locally with the upgrade message", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 12 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      await expect(
        remote.controller.listSkills({ kind: "conversation", conversationId: id(7) }),
      ).rejects.toThrow("needs protocol 5.13");
      expect(sent.some((frame) => frame.type === "call" && frame.method === "listSkills")).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("listSkills is not queued behind a hanging command", async () => {
    // Same read-only, unqueued shape as listFiles (issue #143): a hung command
    // holds the queue — listSkills is still sent and resolves immediately.
    const { transport, sent, holdCall } = fakeTransport([{}], {}, (frame) =>
      frame.method === "listSkills"
        ? { ok: true, value: { skills: [{ name: "review", description: "Reviews code", source: "user" }] } }
        : undefined,
    );
    holdCall("archive");
    const remote = await connectRemoteDurable({ transport });
    try {
      const hanging = remote.controller.archive(id(1), true);
      // A tick so archive's op has run: its call frame is in flight, unanswered.
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent.some((frame) => frame.type === "call" && frame.method === "archive")).toBe(true);
      const answer = await remote.controller.listSkills({ kind: "conversation", conversationId: id(7) });
      expect(answer).toEqual({ skills: [{ name: "review", description: "Reviews code", source: "user" }] });
      const calls = sent.filter((frame) => frame.type === "call");
      expect(calls.map((frame) => frame.method)).toEqual(["archive", "listSkills"]);
      remote.close();
      // close() fails the pending archive call — the command resolves into a notice.
      await hanging;
    } finally {
      remote.close();
    }
  });

  it("refuses the agent calls on a 5.5 host: upgrade message, no frame, agents stays null", async () => {
    const { transport, sent } = fakeTransport([{}], { protocol: { major: PROTOCOL.major, minor: 5 } });
    const remote = await connectRemoteDurable({ transport });
    try {
      const role = { name: "reviewer", description: "Reviews code", prompt: "Look for mistakes." };
      await expect(remote.controller.createAgent(role)).rejects.toThrow("needs protocol 5.6");
      await expect(remote.controller.updateAgent(role)).rejects.toThrow("pinomad upgrade");
      await expect(remote.controller.deleteAgent("reviewer")).rejects.toThrow("pinomad upgrade");
      expect(sent.some((frame) => frame.type === "call" && frame.method === "createAgent")).toBe(false);
      expect(remote.view.current().agents).toBeNull();
      expect(subscribes(sent)).not.toContain("agents");
    } finally {
      remote.close();
    }
  });

  it("subscribes to agents on a 5.6 host and mirrors the stream", async () => {
    const { transport, sent, release } = fakeTransport([{}]);
    const remote = await connectRemoteDurable({ transport });
    try {
      expect(subscribes(sent)).toContain("agents");
      expect(remote.view.current().agents).toEqual(SNAPSHOTS.agents);
      release("agents", {
        roles: [{ name: "reviewer", description: "Reviews code", prompt: "Look for mistakes." }],
        problems: [],
      });
      await waitForView(remote, (view) => view.agents?.roles.length === 1);
    } finally {
      remote.close();
    }
  });

  it("exposes the hello's host identity as view.host; version is absent on a source checkout", async () => {
    const { transport } = fakeTransport([{}], { hostVersion: "1.2.3" });
    const remote = await connectRemoteDurable({ transport });
    try {
      expect(remote.view.current().host).toEqual({
        version: "1.2.3",
        protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor },
      });
    } finally {
      remote.close();
    }

    const source = await connectRemoteDurable({ transport: fakeTransport([{}]).transport });
    try {
      expect(source.view.current().host).toEqual({
        protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor },
      });
    } finally {
      source.close();
    }
  });
});
