// Terminals over the gateway (#547, ADR-0041): hello, the per-owner list
// stream, the output stream with replay, and the host ending shells on
// archive, close and shutdown.
import { once } from "node:events";
import type { ConversationId } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import type { TerminalList } from "@pinomad/protocol/terminals.ts";
import { connectTo, startChat, startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();
const SIZE = { cols: 80, rows: 24 };

type Result = { ok: boolean; value?: unknown; error?: string };

/** A bare socket client: calls, subscriptions, and every frame it was sent. */
async function rawClient(host: { url: string; token: string }) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  const frames: ServerFrame[] = [];
  const pending = new Map<number, (value: Result) => void>();
  const waiters: { test: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] = [];
  let next = 0;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "result") {
      pending.get(frame.id)?.(frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error });
      pending.delete(frame.id);
    }
    for (const waiter of waiters.filter((w) => w.test(frame))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  await once(socket, "open");
  defer(() => socket.terminate());
  const client = {
    frames,
    call: (method: string, args: unknown) =>
      new Promise<Result>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    /** The first frame (already seen or still to come) that passes `test`. */
    next: (test: (frame: ServerFrame) => boolean) =>
      new Promise<ServerFrame>((resolve) => {
        const seen = frames.find(test);
        if (seen !== undefined) resolve(seen);
        else waiters.push({ test, resolve });
      }),
    /** Output text on a terminal stream, reset-aware, once it matches. */
    output: async (stream: string, test: RegExp) => {
      for (;;) {
        let text = "";
        for (const frame of frames) {
          if (frame.type === "output" && frame.stream === stream) text = frame.reset === true ? frame.data : text + frame.data;
        }
        if (test.test(text)) return text;
        const count = frames.length;
        await client.next((frame) => frames.length > count && frame.type === "output" && frame.stream === stream);
      }
    },
    list: async (conversationId: ConversationId, test: (list: TerminalList) => boolean) => {
      const stream = `terminals:${conversationId}`;
      const frame = await client.next((f) => f.type === "snapshot" && f.stream === stream && test(f.value as TerminalList));
      return (frame as { value: TerminalList }).value;
    },
  };
  return client;
}

async function setup(options: Parameters<typeof startFauxHost>[1] = {}) {
  const host = await startFauxHost(defer, { answers: ["hello"], ...options });
  const durable = await connectTo(defer, host);
  const conversationId = await startChat(durable, "hi");
  const raw = await rawClient(host);
  return { host, conversationId, raw };
}

describe("gateway terminals", () => {
  it("announces terminals in the hello and streams one owner's list", async () => {
    const { conversationId, raw } = await setup();
    const hello = await raw.next((frame) => frame.type === "hello");
    expect(hello).toMatchObject({ terminals: { limit: 8 }, protocol: { minor: 27 } });

    raw.send({ type: "subscribe", stream: `terminals:${conversationId}` });
    expect(await raw.list(conversationId, () => true)).toEqual({ owner: conversationId, limit: 8, terminals: [] });

    const opened = await raw.call("openTerminal", { conversationId, ...SIZE });
    expect(opened.ok).toBe(true);
    const { terminalId } = opened.value as { terminalId: string };
    const list = await raw.list(conversationId, (value) => value.terminals.length === 1);
    expect(list.terminals[0]).toMatchObject({ id: terminalId, name: "Terminal 1", cols: 80, rows: 24 });
  });

  it("streams output, takes input, and resumes from a position without a reset", async () => {
    const { conversationId, raw } = await setup();
    const { terminalId } = (await raw.call("openTerminal", { conversationId, ...SIZE })).value as { terminalId: string };
    const stream = `terminal:${terminalId}`;
    raw.send({ type: "subscribe", stream });
    expect((await raw.call("terminalInput", { terminalId, data: "echo first-$((1 + 1))\r" })).ok).toBe(true);
    await raw.output(stream, /first-2\r?\n/);
    const position = (raw.frames.filter((frame) => frame.type === "output").at(-1) as { seq: number }).seq;

    raw.send({ type: "unsubscribe", stream });
    await raw.call("terminalInput", { terminalId, data: "echo second\r" });
    const before = raw.frames.length;
    raw.send({ type: "subscribe", stream, since: position });
    const resumed = await raw.next(
      (frame) => frame.type === "output" && frame.stream === stream && raw.frames.indexOf(frame) >= before,
    );
    // Only what came after the position, never the buffer again.
    expect((resumed as { reset?: true }).reset).toBeUndefined();
    expect((resumed as { data: string }).data).not.toContain("first-2");
  });

  it("ends the output stream and empties the list when a terminal closes", async () => {
    const { conversationId, raw } = await setup();
    const { terminalId } = (await raw.call("openTerminal", { conversationId, ...SIZE })).value as { terminalId: string };
    raw.send({ type: "subscribe", stream: `terminals:${conversationId}` });
    raw.send({ type: "subscribe", stream: `terminal:${terminalId}` });
    await raw.list(conversationId, (value) => value.terminals.length === 1);
    expect((await raw.call("closeTerminal", { terminalId })).ok).toBe(true);
    expect(await raw.next((frame) => frame.type === "ended" && frame.stream === `terminal:${terminalId}`)).toMatchObject({
      reason: "Terminal closed",
    });
    await raw.list(conversationId, (value) => value.terminals.length === 0);
    expect(await raw.call("terminalInput", { terminalId, data: "x" })).toEqual({ ok: false, error: "Unknown terminal" });
  });

  it("ends an unknown terminal's stream instead of hanging", async () => {
    const { raw } = await setup();
    raw.send({ type: "subscribe", stream: "terminal:not-a-terminal" });
    expect(await raw.next((frame) => frame.type === "ended")).toMatchObject({ reason: "Unknown terminal" });
  });

  it("closes the family's terminals when its root is archived", async () => {
    const { conversationId, raw } = await setup();
    raw.send({ type: "subscribe", stream: `terminals:${conversationId}` });
    await raw.call("openTerminal", { conversationId, ...SIZE });
    await raw.list(conversationId, (value) => value.terminals.length === 1);
    expect((await raw.call("archive", { conversationId, archived: true })).ok).toBe(true);
    await raw.list(conversationId, (value) => value.terminals.length === 0);
  });

  it("ends every shell when the host closes", async () => {
    const { host, conversationId, raw } = await setup();
    const { terminalId } = (await raw.call("openTerminal", { conversationId, ...SIZE })).value as { terminalId: string };
    const stream = `terminal:${terminalId}`;
    raw.send({ type: "subscribe", stream });
    await raw.call("terminalInput", { terminalId, data: "echo pid=$$\r" });
    const pid = Number((await raw.output(stream, /pid=(\d+)\r?\n/)).match(/pid=(\d+)\r?\n/)![1]);
    expect(alive(pid)).toBe(true);
    await host.close();
    await until(() => !alive(pid));
  });

  it("refuses terminal calls and leaves hello.terminals out when the pty module is missing", async () => {
    const { conversationId, raw } = await setup({
      terminals: { load: () => Promise.reject(new Error("no prebuild")), diagnostic: () => {} },
    });
    const hello = await raw.next((frame) => frame.type === "hello");
    expect(hello).not.toHaveProperty("terminals");
    expect(await raw.call("openTerminal", { conversationId, ...SIZE })).toEqual({
      ok: false,
      error: "Terminals are unavailable on this host",
    });
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(test: () => boolean): Promise<void> {
  while (!test()) await new Promise((resolve) => setTimeout(resolve, 20));
}
