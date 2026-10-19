import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "@pinomad/protocol/frames.ts";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "@pinomad/protocol/transport.ts";
import { useRemoteDurable } from "./use-remote.ts";

const SNAPSHOTS: Record<string, unknown> = {
  conversations: [],
  index: { projects: [], conversations: [] },
  devices: { devices: [] },
  tasks: { tasks: {} },
  mcp: null,
  models: [],
  auth: { logins: [] },
  settings: {
    defaultModel: null,
    defaultThinkingLevel: null,
    steeringMode: "all",
    followUpMode: "all",
    custom: [],
  },
  agents: { roles: [], problems: [] },
};

function snapshotFor(stream: string): unknown {
  if (stream in SNAPSHOTS) return SNAPSHOTS[stream];
  if (stream.startsWith("conversation:")) return { conversation: { id: 1 }, entries: [] };
  if (stream.startsWith("doc:")) return null;
  return null;
}

interface OpenedConnection {
  readonly handlers: FrameHandlers;
  readonly sent: ClientFrame[];
  closed: boolean;
  /** Deliver the host hello: the frame flow that eventually resolves ready. */
  greet(): void;
}

/**
 * A host endpoint that answers every subscribe with a snapshot. `silent`
 * accepts the connection but never greets — packets go out, nothing comes
 * back, the case the first-connect timeout exists for.
 */
function fakeTransport(options?: { silent?: boolean }) {
  const opened: OpenedConnection[] = [];
  const transport: FrameTransport = {
    label: "ws://dead-host:7433",
    open(handlers): FrameConnection {
      const entry: OpenedConnection = {
        handlers,
        sent: [],
        closed: false,
        greet: () =>
          handlers.message(
            JSON.stringify({
              type: "hello",
              protocol: PROTOCOL,
              session: { id: "fake", directory: "" },
              models: [],
              docs: [],
              toolPresentations: {},
              defaults: {},
            }),
          ),
      };
      opened.push(entry);
      if (options?.silent !== true) queueMicrotask(() => entry.greet());
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          entry.sent.push(frame);
          if (frame.type === "subscribe") {
            const snapshot: ServerFrame = { type: "snapshot", stream: frame.stream, value: snapshotFor(frame.stream) };
            queueMicrotask(() => handlers.message(JSON.stringify(snapshot)));
          }
        },
        close() {
          entry.closed = true;
          queueMicrotask(() => handlers.closed(1000));
        },
      };
    },
  };
  return { transport, opened };
}

const TIMEOUT_MS = 15_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRemoteDurable first-connect timeout", () => {
  it("fails after the timeout and closes the silent connection", async () => {
    const { transport, opened } = fakeTransport({ silent: true });
    const { result } = renderHook(() => useRemoteDurable({ transport }, "key", { timeoutMs: TIMEOUT_MS }));
    expect(result.current.status).toBe("connecting");
    expect(opened).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_MS));
    const state = result.current;
    expect(state).toMatchObject({ status: "failed", unauthorized: false });
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.error).toContain("ws://dead-host:7433");
    expect(state.error).toContain("15 seconds");
    expect(opened[0]!.closed).toBe(true);
  });

  it("stays ready when the host answers in time", async () => {
    const { transport, opened } = fakeTransport();
    const { result } = renderHook(() => useRemoteDurable({ transport }, "key", { timeoutMs: TIMEOUT_MS }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.status).toBe("ready");

    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2));
    expect(result.current.status).toBe("ready");
    expect(opened[0]!.closed).toBe(false);
  });

  it("a ready arriving after the timeout cannot override the failure and is closed", async () => {
    const silent = fakeTransport({ silent: true });
    let resolveConnect!: (remote: RemoteDurable) => void;
    const connect = vi.fn(() => new Promise<RemoteDurable>((resolve) => (resolveConnect = resolve)));
    const remote = { close: vi.fn() } as unknown as RemoteDurable;
    const { result } = renderHook(() =>
      useRemoteDurable({ transport: silent.transport }, "key", { timeoutMs: TIMEOUT_MS, connect }),
    );

    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_MS));
    expect(result.current.status).toBe("failed");

    await act(async () => {
      resolveConnect(remote);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("failed");
    expect(remote.close).toHaveBeenCalled();
  });

  it("a key change cancels the old timer and closes the old connection", async () => {
    const first = fakeTransport({ silent: true });
    const second = fakeTransport({ silent: true });
    const { result, rerender } = renderHook(
      ({ key, transport }) => useRemoteDurable({ transport }, key, { timeoutMs: TIMEOUT_MS }),
      { initialProps: { key: "first", transport: first.transport } },
    );
    expect(result.current.status).toBe("connecting");

    rerender({ key: "second", transport: second.transport });
    expect(result.current.status).toBe("connecting");
    expect(first.opened[0]!.closed).toBe(true);
    expect(second.opened).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1));
    expect(result.current.status).toBe("connecting");
    expect(second.opened[0]!.closed).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.status).toBe("failed");
    expect(second.opened[0]!.closed).toBe(true);
  });
});
