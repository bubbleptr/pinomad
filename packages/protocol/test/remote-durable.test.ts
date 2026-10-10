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
function fakeTransport(defaultsList: readonly ConversationDefaults[]): {
  transport: FrameTransport;
  opened: FrameHandlers[];
  sent: ClientFrame[];
  disconnect: () => void;
  /** Subscribes to a held stream get no snapshot until `release` sends one. */
  hold: (stream: StreamName) => void;
  release: (stream: StreamName, value: unknown) => void;
} {
  const opened: FrameHandlers[] = [];
  const sent: ClientFrame[] = [];
  const held = new Set<StreamName>();
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      opened.push(handlers);
      const defaults = defaultsList[Math.min(opened.length - 1, defaultsList.length - 1)]!;
      const hello: ServerFrame = {
        type: "hello",
        protocol: PROTOCOL,
        session: { id: "fake", directory: "" },
        models: [],
        docs: [DOC],
        toolPresentations: {},
        defaults,
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
            const result: ServerFrame = { type: "result", id: frame.id, ok: true, value: undefined };
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
    const { transport, disconnect } = fakeTransport([{}, second]);
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
      await remote.controller.submit("to the side", "followUp", id(2));
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
