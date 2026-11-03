// The client side of terminals (5.27, ADR-0041): availability from the hello,
// the per-conversation list, output with resume after a reconnect, and calls
// that never wait behind the command queue.
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PROTOCOL, type ClientFrame, type ServerFrame } from "../src/frames.ts";
import { connectRemoteDurable, type RemoteDurable, type TerminalsState } from "../src/remote-durable.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "../src/transport.ts";
import { terminalsStream, type TerminalList } from "../src/terminals.ts";

const id = (n: number): ConversationId => n as ConversationId;
const SIZE = { cols: 80, rows: 24 };
const LIST: TerminalList = {
  owner: id(1),
  limit: 8,
  terminals: [{ id: "t-1", name: "Terminal 1", renamed: false, cols: 80, rows: 24 }],
};

/**
 * A host that says hello with `hello` (minor and terminals), answers host and
 * conversation subscribes with snapshots and `terminals:` with LIST, never
 * snapshots a `terminal:` stream, and answers calls ok unless held.
 */
function fakeHost(hello: { minor?: number; terminals?: { limit: number } | undefined } = { terminals: { limit: 8 } }) {
  const opened: FrameHandlers[] = [];
  const sent: ClientFrame[] = [];
  const heldCalls = new Set<string>();
  const transport: FrameTransport = {
    label: "fake",
    open(handlers): FrameConnection {
      opened.push(handlers);
      const frame = {
        type: "hello",
        protocol: { major: PROTOCOL.major, minor: hello.minor ?? PROTOCOL.minor },
        session: { id: "fake", directory: "" },
        models: [],
        docs: [],
        toolPresentations: {},
        defaults: {},
        ...(hello.terminals === undefined ? {} : { terminals: hello.terminals }),
      };
      queueMicrotask(() => handlers.message(JSON.stringify(frame)));
      return {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          sent.push(frame);
          if (frame.type === "subscribe") {
            if (frame.stream.startsWith("terminal:")) return;
            const value = frame.stream.startsWith("terminals:")
              ? LIST
              : frame.stream.startsWith("conversation:")
                ? { conversation: { id: Number(frame.stream.slice("conversation:".length)) }, entries: [] }
                : SNAPSHOTS[frame.stream] ?? null;
            queueMicrotask(() => handlers.message(JSON.stringify({ type: "snapshot", stream: frame.stream, value })));
          } else if (frame.type === "call") {
            if (heldCalls.has(frame.method)) return;
            const value = frame.method === "openTerminal" ? { terminalId: "t-2" } : null;
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
    holdCall: (method: string) => heldCalls.add(method),
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

async function connect(host: ReturnType<typeof fakeHost>): Promise<RemoteDurable> {
  return connectRemoteDurable({ transport: host.transport, reconnectDelayMs: { min: 20, max: 20 } });
}

describe("RemoteDurable terminals", () => {
  it("reports terminals unavailable without subscribing when the hello leaves them out or the host is too old", async () => {
    for (const hello of [{ terminals: undefined }, { minor: 26, terminals: { limit: 8 } }]) {
      const host = fakeHost(hello);
      const remote = await connect(host);
      try {
        const states: TerminalsState[] = [];
        remote.terminals.watch(id(1), (state) => states.push(state));
        expect(states).toEqual([{ kind: "unavailable", reason: expect.any(String) }]);
        expect(subscribes(host.sent).map((frame) => frame.stream)).not.toContain(terminalsStream(id(1)));
        await expect(remote.terminals.open(id(1), SIZE)).rejects.toThrow(states[0]!.kind === "unavailable" ? states[0]!.reason : "");
      } finally {
        remote.close();
      }
    }
  });

  it("watches one conversation's list and unsubscribes once the last watcher stops", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const first: TerminalsState[] = [];
      const second: TerminalsState[] = [];
      const stopFirst = remote.terminals.watch(id(1), (state) => first.push(state));
      const stopSecond = remote.terminals.watch(id(1), (state) => second.push(state));
      await until(() => first.at(-1)?.kind === "ready");
      expect(first).toEqual([{ kind: "loading" }, { kind: "ready", list: LIST }]);
      expect(second.at(-1)).toEqual({ kind: "ready", list: LIST });
      expect(subscribes(host.sent).filter((frame) => frame.stream === terminalsStream(id(1)))).toHaveLength(1);
      // A late watcher starts from the list already there.
      const late: TerminalsState[] = [];
      remote.terminals.watch(id(1), (state) => late.push(state))();
      expect(late).toEqual([{ kind: "ready", list: LIST }]);

      stopFirst();
      expect(host.sent.some((frame) => frame.type === "unsubscribe")).toBe(false);
      stopSecond();
      expect(host.sent.at(-1)).toEqual({ type: "unsubscribe", stream: "terminals:1" });
    } finally {
      remote.close();
    }
  });

  it("hands output to the attached sink and resumes after a reconnect from the last position, with the last size", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const output: [string, boolean][] = [];
      remote.terminals.attach("t-1", { output: (data, reset) => output.push([data, reset]), ended: () => {} });
      remote.terminals.resize("t-1", { cols: 120, rows: 40 });
      expect(subscribes(host.sent).at(-1)).toEqual({ type: "subscribe", stream: "terminal:t-1" });
      host.push({ type: "output", stream: "terminal:t-1", seq: 6, data: "hello\n", reset: true });
      host.push({ type: "output", stream: "terminal:t-1", seq: 9, data: "$ \n" });
      expect(output).toEqual([
        ["hello\n", true],
        ["$ \n", false],
      ]);

      const before = host.sent.length;
      host.disconnect();
      await until(() => host.connections() === 2 && remote.view.current().connection === "connected");
      await until(() => calls(host.sent.slice(before), "resizeTerminal").length === 1);
      const after = host.sent.slice(before);
      expect(subscribes(after)).toContainEqual({ type: "subscribe", stream: "terminal:t-1", since: 9 });
      expect(calls(after, "resizeTerminal")[0]!.args).toEqual({ terminalId: "t-1", cols: 120, rows: 40 });
    } finally {
      remote.close();
    }
  });

  it("never holds a reconnect's call gate on a terminal stream, which has no snapshot", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      await remote.controller.switchConversation(id(1));
      remote.terminals.attach("t-1", { output: () => {}, ended: () => {} });
      host.disconnect();
      await until(() => host.connections() === 2 && remote.view.current().connection === "connected");
      await remote.controller.renameConversation(id(1), "after");
      expect(calls(host.sent, "renameConversation")).toHaveLength(1);
    } finally {
      remote.close();
    }
  });

  it("sends input at once, even while a command is still waiting on the host", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      host.holdCall("archive");
      void remote.controller.archive(id(1), true);
      await until(() => calls(host.sent, "archive").length === 1);
      remote.terminals.input("t-1", "ls\r");
      expect(calls(host.sent, "terminalInput").map((frame) => frame.args)).toEqual([{ terminalId: "t-1", data: "ls\r" }]);
    } finally {
      remote.close();
    }
  });

  it("ends the sink once the host ends the stream, and leaves it out of the next reconnect", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const ended: string[] = [];
      remote.terminals.attach("t-1", { output: () => {}, ended: (reason) => ended.push(reason) });
      host.push({ type: "ended", stream: "terminal:t-1", reason: "Terminal closed" });
      expect(ended).toEqual(["Terminal closed"]);

      const before = host.sent.length;
      host.disconnect();
      await until(() => host.connections() === 2 && remote.view.current().connection === "connected");
      expect(subscribes(host.sent.slice(before)).map((frame) => frame.stream)).not.toContain("terminal:t-1");
    } finally {
      remote.close();
    }
  });

  it("detaching unsubscribes, and a fresh attach replays from the start", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      const detach = remote.terminals.attach("t-1", { output: () => {}, ended: () => {} });
      host.push({ type: "output", stream: "terminal:t-1", seq: 4, data: "abcd", reset: true });
      detach();
      expect(host.sent.at(-1)).toEqual({ type: "unsubscribe", stream: "terminal:t-1" });
      remote.terminals.attach("t-1", { output: () => {}, ended: () => {} });
      expect(host.sent.at(-1)).toEqual({ type: "subscribe", stream: "terminal:t-1" });
    } finally {
      remote.close();
    }
  });

  it("opens, renames, restarts and closes through the host's calls", async () => {
    const host = fakeHost();
    const remote = await connect(host);
    try {
      expect(await remote.terminals.open(id(1), SIZE)).toBe("t-2");
      await remote.terminals.rename("t-2", "dev");
      await remote.terminals.restart("t-2", SIZE);
      await remote.terminals.close("t-2");
      const args = (method: string) => calls(host.sent, method).map((frame) => frame.args);
      expect(args("openTerminal")).toEqual([{ conversationId: 1, cols: 80, rows: 24 }]);
      expect(args("renameTerminal")).toEqual([{ terminalId: "t-2", name: "dev" }]);
      expect(args("restartTerminal")).toEqual([{ terminalId: "t-2", cols: 80, rows: 24 }]);
      expect(args("closeTerminal")).toEqual([{ terminalId: "t-2" }]);
    } finally {
      remote.close();
    }
  });
});
