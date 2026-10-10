import { describe, expect, it } from "vitest";
import { INVALID_FRAME_CLOSE_CODE, PROTOCOL, UNAUTHORIZED_CLOSE_CODE, type ClientFrame, type ServerFrame } from "../src/frames.ts";
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

/**
 * A transport whose n-th connection says hello with `defaultsList[n]` (last
 * repeats) and answers subscribes with empty snapshots. `disconnect()` closes
 * the latest connection server-side so the client reconnects.
 */
function fakeTransport(defaultsList: readonly ConversationDefaults[]): {
  transport: FrameTransport;
  opened: FrameHandlers[];
  disconnect: () => void;
} {
  const opened: FrameHandlers[] = [];
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
        docs: [],
        toolPresentations: {},
        defaults,
      };
      queueMicrotask(() => handlers.message(JSON.stringify(hello)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          if (frame.type !== "subscribe" || !(frame.stream in SNAPSHOTS)) return;
          const snapshot: ServerFrame = { type: "snapshot", stream: frame.stream, value: SNAPSHOTS[frame.stream] };
          queueMicrotask(() => handlers.message(JSON.stringify(snapshot)));
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
    disconnect: () => opened.at(-1)?.closed(1000),
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
