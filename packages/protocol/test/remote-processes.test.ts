// The client side of background processes (5.32, ADR-0045): the family
// root's list document, output resumed after a reconnect, the stop call, and
// the host capabilities that gate both.
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { docStream, PROTOCOL, type ClientFrame, type ServerFrame } from "../src/frames.ts";
import { connectRemoteDurable, type ProcessListState, type RemoteDurable } from "../src/remote-durable.ts";
import type { ProcessInfo } from "../src/processes.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "../src/transport.ts";

const id = (n: number): ConversationId => n as ConversationId;
const doc = (n: number) => docStream("pinomad.processes", id(n));
const LIST: readonly ProcessInfo[] = [
  {
    id: "p-dev",
    owner: id(1),
    name: "dev server",
    command: "bun run dev",
    startedAt: 10,
    state: "running",
  },
  {
    id: "p-test",
    owner: id(4),
    name: "bun test",
    command: "bun test",
    startedAt: 1,
    endedAt: 3,
    state: { exited: 1 },
  },
];

type HelloOptions = {
  minor?: number;
  processes?: { limit: number } | undefined;
  docs?: readonly { kind: string; presentation?: "pinomad.processes" }[];
};

const DEFAULT_DOCS = [{ kind: "pinomad.processes", presentation: "pinomad.processes" as const }];

/**
 * A host that answers the process list document with LIST, output streams
 * with whatever the test pushes, and calls ok. `setHello` changes what the
 * next reconnect announces.
 */
function fakeHost(hello: HelloOptions = { processes: { limit: 8 } }) {
  let current = hello;
  const opened: FrameHandlers[] = [];
  const sent: ClientFrame[] = [];
  const held = new Set<string>();
  let active: FrameHandlers | undefined;
  const snapshotFor = (stream: string): unknown =>
    stream === doc(1) || stream === doc(4)
      ? { processes: LIST }
      : stream.startsWith("conversation:")
        ? { conversation: { id: Number(stream.slice("conversation:".length)) }, entries: [] }
        : SNAPSHOTS[stream] ?? null;
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      opened.push(handlers);
      active = handlers;
      const frame = {
        type: "hello",
        protocol: { major: PROTOCOL.major, minor: current.minor ?? PROTOCOL.minor },
        session: { id: "fake", directory: "" },
        models: [],
        docs: current.docs ?? DEFAULT_DOCS,
        toolPresentations: {},
        defaults: {},
        ...(current.processes === undefined ? {} : { processes: current.processes }),
      };
      queueMicrotask(() => handlers.message(JSON.stringify(frame)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          sent.push(frame);
          if (frame.type === "subscribe") {
            if (frame.stream.startsWith("terminal:") || frame.stream.startsWith("process:")) return;
            if (held.has(frame.stream)) return;
            const value = snapshotFor(frame.stream);
            queueMicrotask(() => handlers.message(JSON.stringify({ type: "snapshot", stream: frame.stream, value })));
          } else if (frame.type === "call") {
            const value = frame.method === "stopProcess" ? { state: { stopped: "user" } } : null;
            queueMicrotask(() => handlers.message(JSON.stringify({ type: "result", id: frame.id, ok: true, value })));
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
    sent,
    push: (frame: ServerFrame) => opened.at(-1)!.message(JSON.stringify(frame)),
    disconnect: () => opened.at(-1)?.closed(1000),
    connections: () => opened.length,
    setHello: (next: HelloOptions) => {
      current = next;
    },
    hold: (stream: string) => held.add(stream),
    release: (stream: string) => {
      held.delete(stream);
      const value = snapshotFor(stream);
      queueMicrotask(() => active?.message(JSON.stringify({ type: "snapshot", stream, value })));
    },
  };
}

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
    defaultThinkingLevel: "off",
    steeringMode: "all",
    followUpMode: "all",
    hostName: "Testbox",
    custom: [],
  },
  agents: { roles: [], problems: [] },
};

function subscribes(sent: readonly ClientFrame[]) {
  return sent.filter((frame): frame is Extract<ClientFrame, { type: "subscribe" }> => frame.type === "subscribe");
}

function calls(sent: readonly ClientFrame[], method: string) {
  return sent.filter((frame): frame is Extract<ClientFrame, { type: "call" }> => frame.type === "call" && frame.method === method);
}

async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("condition not met within 5s");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not finish within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function connect(host: ReturnType<typeof fakeHost>): Promise<RemoteDurable> {
  return connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 20, max: 20 } });
}

describe("RemoteDurable processes", () => {
  it("gates output and Stop while still streaming the list a 5.32 host keeps without a process module", async () => {
    for (const hello of [
      { processes: undefined, listable: true },
      { minor: 31, processes: { limit: 8 }, listable: false },
    ]) {
      const host = fakeHost(hello);
      const remote = await connect(host);
      try {
        expect(remote.processes.unavailable()).toEqual(expect.any(String));
        const states: ProcessListState[] = [];
        remote.processes.watch(id(1), (state) => states.push(state));
        expect(states).toEqual([{ processes: [], unavailable: expect.any(String) }]);
        expect(subscribes(host.sent).some((frame) => frame.stream === doc(1))).toBe(hello.listable);

        const ended: string[] = [];
        remote.processes.attach("p-dev", undefined, { output: () => {}, ended: (reason) => ended.push(reason) });
        expect(ended).toEqual([remote.processes.unavailable()]);
        expect(subscribes(host.sent).map((frame) => frame.stream)).not.toContain("process:p-dev");

        await expect(remote.processes.stop(id(1), "p-dev")).rejects.toThrow(remote.processes.unavailable()!);
      } finally {
        remote.close();
      }
    }
  });

  it("watches a family root's document even when the host has no process module, and unsubscribes with the last watcher", async () => {
    const host = fakeHost({ processes: undefined });
    const remote = await connect(host);
    try {
      const states: ProcessListState[] = [];
      const stop = remote.processes.watch(id(1), (state) => states.push(state));
      await until(() => states.at(-1)?.processes.length === LIST.length);
      expect(states[0]).toEqual({ processes: [], unavailable: expect.any(String) });
      expect(states.at(-1)).toEqual({ processes: LIST, unavailable: expect.any(String) });
      expect(subscribes(host.sent).filter((frame) => frame.stream === doc(1))).toHaveLength(1);

      // A late watcher starts from the list already on the stream.
      const late: ProcessListState[] = [];
      remote.processes.watch(id(1), (state) => late.push(state))();
      expect(late.at(-1)?.processes).toEqual(LIST);

      stop();
      expect(host.sent.at(-1)).toEqual({ type: "unsubscribe", stream: doc(1) });
    } finally {
      remote.close();
    }
  });

  it("does not subscribe to a process document the hello does not offer", async () => {
    const host = fakeHost({ docs: [], processes: { limit: 8 } });
    const remote = await connect(host);
    try {
      const states: ProcessListState[] = [];
      remote.processes.watch(id(1), (state) => states.push(state));
      expect(states).toEqual([{ processes: [] }]);
      expect(subscribes(host.sent).map((frame) => frame.stream)).not.toContain(doc(1));
    } finally {
      remote.close();
    }
  });

  it("keeps a process document a shown conversation also needs", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      // The panel's family root is the shown conversation here, so its doc is
      // also part of the conversation slot's streams.
      await remote.controller.switchConversation(id(1));
      const stop = remote.processes.watch(id(1), () => {});
      await until(() => subscribes(host.sent).some((frame) => frame.stream === doc(1)));
      stop();
      expect(host.sent.some((frame) => frame.type === "unsubscribe" && frame.stream === doc(1))).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("keeps a document that a switch is still acquiring when its last process watcher leaves", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      await remote.controller.switchConversation(id(1));
      const before = host.sent.length;
      host.hold(doc(4));
      const switching = remote.controller.switchConversation(id(4));
      await until(() => subscribes(host.sent.slice(before)).some((frame) => frame.stream === doc(4)));

      // The panel watches the new root while the switch is still waiting for
      // its snapshot; leaving before it lands must not drop the acquisition.
      const unwatch = remote.processes.watch(id(4), () => {});
      unwatch();
      host.release(doc(4));

      await withTimeout(switching);
      expect(remote.view.current().conversation?.conversation.id).toBe(4);
      await withTimeout(remote.controller.renameConversation(id(4), "after"));
      expect(calls(host.sent, "renameConversation").map((frame) => frame.args)).toEqual([
        { conversationId: 4, title: "after" },
      ]);
    } finally {
      remote.close();
    }
  });

  it("sends the raw output position and resumes from it after a reconnect", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const output: [string, boolean][] = [];
      remote.processes.attach("p-dev", 3, { output: (data, reset) => output.push([data, reset]), ended: () => {} });
      expect(subscribes(host.sent).at(-1)).toEqual({ type: "subscribe", stream: "process:p-dev", since: 3 });
      host.push({ type: "output", stream: "process:p-dev", seq: 12, data: "ready\n", reset: true });
      expect(output).toEqual([["ready\n", true]]);

      const before = host.sent.length;
      host.disconnect();
      await until(() => host.connections() === 2 && remote.view.current().connection === "connected");
      expect(subscribes(host.sent.slice(before))).toContainEqual({ type: "subscribe", stream: "process:p-dev", since: 12 });
    } finally {
      remote.close();
    }
  });

  it("ends the sink once the host ends the stream, and leaves it out of the next reconnect", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const ended: string[] = [];
      remote.processes.attach("p-dev", undefined, { output: () => {}, ended: (reason) => ended.push(reason) });
      host.push({ type: "ended", stream: "process:p-dev", reason: "Output released" });
      expect(ended).toEqual(["Output released"]);

      const before = host.sent.length;
      host.disconnect();
      await until(() => host.connections() === 2 && remote.view.current().connection === "connected");
      expect(subscribes(host.sent.slice(before)).map((frame) => frame.stream)).not.toContain("process:p-dev");
    } finally {
      remote.close();
    }
  });

  it("unsubscribes output and ends the sink when a reconnect loses the capability", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const ended: string[] = [];
      remote.processes.attach("p-dev", undefined, { output: () => {}, ended: (reason) => ended.push(reason) });
      expect(subscribes(host.sent).map((frame) => frame.stream)).toContain("process:p-dev");

      const before = host.sent.length;
      host.setHello({ minor: 31, processes: undefined });
      host.disconnect();
      await until(() => host.connections() === 2);
      await until(() => ended.length === 1);
      expect(ended[0]).toEqual(expect.any(String));
      expect(remote.processes.unavailable()).toEqual(ended[0]);
      expect(subscribes(host.sent.slice(before)).map((frame) => frame.stream)).not.toContain("process:p-dev");
    } finally {
      remote.close();
    }
  });

  it("stops through stopProcess with the process's conversation", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      expect(await remote.processes.stop(id(4), "p-test")).toEqual({ stopped: "user" });
      expect(calls(host.sent, "stopProcess").map((frame) => frame.args)).toEqual([{ conversationId: 4, id: "p-test" }]);
    } finally {
      remote.close();
    }
  });
});
