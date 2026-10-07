import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../src/frames.ts";
import { connectRemoteDurable, ProtocolMismatchError, type RemoteDurable } from "../src/remote-durable.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "../src/transport.ts";
import type { DurableView } from "../src/view.ts";

const SNAPSHOTS: Record<string, unknown> = {
  conversations: [],
  index: { projects: [], conversations: [] },
  devices: { devices: [] },
  tasks: { tasks: {} },
  mcp: null,
};

interface Fake {
  readonly transport: FrameTransport;
  /** Handlers of every connection the client opened, in order. */
  readonly opened: FrameHandlers[];
  /** Connections that were closed by the client. */
  readonly closedCount: () => number;
}

/** A transport that answers each connection with a hello for `protocols[i]` (last repeats) and snapshots on subscribe. */
function fakeTransport(protocols: readonly number[]): Fake {
  const opened: FrameHandlers[] = [];
  let closedCount = 0;
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      opened.push(handlers);
      const hello: ServerFrame = {
        type: "hello",
        protocol: protocols[Math.min(opened.length - 1, protocols.length - 1)]!,
        session: { id: "fake", directory: "" },
        models: [],
        docs: [],
        toolPresentations: {},
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
          closedCount++;
          queueMicrotask(() => handlers.closed(1000));
        },
      };
    },
  };
  return { transport, opened, closedCount: () => closedCount };
}

/** Resolve once `predicate` holds for the view, checked on every update. */
function waitForView(remote: RemoteDurable, predicate: (view: DurableView) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("view condition not met"));
    }, 5000);
    const unsubscribe = remote.view.subscribe(() => {
      if (!predicate(remote.view.current())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    if (predicate(remote.view.current())) {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

describe("protocol version check", () => {
  it("rejects the initial connect when the hello's protocol does not match", async () => {
    const fake = fakeTransport([PROTOCOL_VERSION + 1]);
    const error = await connectRemoteDurable({ transport: fake.transport }).then(
      () => {
        throw new Error("connected");
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect(error).toMatchObject({ host: PROTOCOL_VERSION + 1, client: PROTOCOL_VERSION });
    expect(fake.closedCount()).toBe(1);
  });

  it("marks the view outdated and stops reconnecting when a reconnect's hello mismatches", async () => {
    const fake = fakeTransport([PROTOCOL_VERSION, PROTOCOL_VERSION + 1]);
    const remote = await connectRemoteDurable({
      transport: fake.transport,
      reconnectDelayMs: { min: 1, max: 1 },
    });
    expect(remote.view.current().connection).toBe("connected");
    fake.opened[0]!.closed(1006);
    await waitForView(remote, (view) => view.connection === "outdated");
    expect(fake.opened).toHaveLength(2);
    // The closed socket is dropped; no further reconnect may be scheduled. The
    // delay is only an assertion bound — the client has no timer left to fire.
    fake.opened[1]!.closed(1006);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.opened).toHaveLength(2);
    remote.close();
  });
});
