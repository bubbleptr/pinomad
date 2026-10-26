import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "@pinomad/protocol/frames.ts";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import { DirectUnavailableError, type RemoteDurable, type RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
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
  /** Times our side called `close()`; a peer-initiated `closed` doesn't count. */
  closeCalls: number;
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
        closeCalls: 0,
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
          entry.closeCalls++;
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
  vi.restoreAllMocks();
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

  it("keeps a typed DirectUnavailableError for the failure screen", async () => {
    const error = new DirectUnavailableError("the ICE connection failed");
    const { result } = renderHook(() =>
      useRemoteDurable({ transport: fakeTransport().transport }, "key", {
        timeoutMs: TIMEOUT_MS,
        connect: () => Promise.reject(error),
      }),
    );
    await act(async () => {});
    const state = result.current;
    expect(state.status).toBe("failed");
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.direct).toBe(error);
  });

  it("returns to connecting when the key changes after a failure", async () => {
    const first = fakeTransport({ silent: true });
    const second = fakeTransport({ silent: true });
    const { result, rerender } = renderHook(
      ({ key, transport }) => useRemoteDurable({ transport }, key, { timeoutMs: TIMEOUT_MS }),
      { initialProps: { key: "first", transport: first.transport } },
    );
    await act(() => vi.advanceTimersByTimeAsync(TIMEOUT_MS));
    expect(result.current.status).toBe("failed");

    rerender({ key: "second", transport: second.transport });
    expect(result.current.status).toBe("connecting");
    expect(second.opened).toHaveLength(1);
  });

  it("does not accumulate connections that the peer closed", async () => {
    const { transport, opened } = fakeTransport();
    const hook = renderHook(() => useRemoteDurable({ transport }, "key", { timeoutMs: TIMEOUT_MS }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.status).toBe("ready");

    // The host's end drops the socket (no close() from our side); the client
    // reconnects on its own. Repeat to catch set growth over reconnects.
    for (let cycle = 0; cycle < 3; cycle++) {
      act(() => opened.at(-1)!.handlers.closed(1006));
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(opened).toHaveLength(cycle + 2);
    }

    act(() => hook.unmount());
    // Peer-closed connections were never ours to close again; only the one
    // live connection takes a close.
    for (const entry of opened.slice(0, -1)) expect(entry.closeCalls).toBe(0);
    expect(opened.at(-1)!.closeCalls).toBe(1);
  });

  it("forwards page visibility to candidate connections", () => {
    const connect = vi.fn((_options: RemoteDurableOptions) => new Promise<RemoteDurable>(() => {}));
    const { unmount } = renderHook(() =>
      useRemoteDurable(
        { candidates: [], openTransport: () => fakeTransport().transport },
        "key",
        { connect },
      ),
    );
    const options = connect.mock.calls[0]![0];
    expect(options.lifecycle).toBeDefined();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const states: string[] = [];
    const stop = options.lifecycle!.subscribe((state) => states.push(state));
    // A page opened in a background tab must start paused, not wait for the
    // next visibilitychange.
    expect(states).toEqual(["background"]);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(states).toEqual(["background", "foreground"]);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(states).toEqual(["background", "foreground", "background"]);

    stop();
    unmount();
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
