import { describe, expect, it } from "vitest";
import type { ClientFrame, ServerFrame } from "../src/frames.ts";
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
        protocol: 4,
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
});
