// Background processes over the gateway (ADR-0045): hello capability, the
// process output stream, and the stop call. The runtime details are covered
// in processes.test.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { createProcesses } from "../src/extensions/processes.ts";
import type { Processes } from "../src/processes.ts";
import { connectTo, startChat, startFauxHost, useCleanups } from "./support.ts";

const CONTEXT = BACKGROUND_CONTEXT;
const defer = useCleanups();

type Result = { ok: boolean; value?: unknown; error?: string };

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
    for (const waiter of waiters.filter((entry) => entry.test(frame))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  await once(socket, "open");
  defer(() => socket.terminate());
  return {
    call: (method: string, args: unknown) =>
      new Promise<Result>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    next: (test: (frame: ServerFrame) => boolean) =>
      new Promise<ServerFrame>((resolve) => {
        const seen = frames.find(test);
        if (seen !== undefined) resolve(seen);
        else waiters.push({ test, resolve });
      }),
  };
}

async function setup(options: Parameters<typeof startFauxHost>[1] = {}) {
  const host = await startFauxHost(defer, {
    answers: ["ok"],
    processes: {
      shell: { file: "/bin/sh", args: [] },
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
    },
    ...options,
  });
  const durable = await connectTo(defer, host);
  const conversationId = await startChat(durable, "hi");
  const raw = await rawClient(host);
  return { host, conversationId, raw };
}

describe("gateway processes", () => {
  it("announces processes and streams raw output on process:<id>", async () => {
    const { host, conversationId, raw } = await setup();
    expect(await raw.next((frame) => frame.type === "hello")).toMatchObject({ processes: { limit: 8 } });
    const started = await host.processes!.start(
      { conversationId, command: "printf 'process-ok\\n'; sleep 30", name: "echo", cwd: process.cwd() },
      CONTEXT,
    );
    const stream = `process:${started.id}`;
    raw.send({ type: "subscribe", stream });
    const frame = await raw.next(
      (candidate) => candidate.type === "output" && candidate.stream === stream,
    );
    expect(frame.type).toBe("output");
    if (frame.type === "output") expect(frame.data).toContain("process-ok");
    expect(await raw.call("stopProcess", { conversationId, id: started.id })).toEqual({
      ok: true,
      value: { state: { stopped: "user" } },
    });
  });

  it("leaves hello.processes out when the pty module is missing but keeps the document", async () => {
    const { conversationId, raw } = await setup({
      processes: { load: () => Promise.reject(new Error("no prebuild")), diagnostic: () => {} },
      extensions: (host: { readonly processes?: Processes }) => [
        createProcesses({ ...(host.processes === undefined ? {} : { runtime: host.processes }) }),
      ],
    });
    const hello = await raw.next((frame) => frame.type === "hello");
    expect(hello).not.toHaveProperty("processes");
    expect(hello.type === "hello" ? hello.docs : []).toContainEqual({
      kind: "pinomad.processes",
      presentation: "pinomad.processes",
    });
    const stream = `doc:pinomad.processes:${conversationId}`;
    raw.send({ type: "subscribe", stream });
    // A document that was never written streams as null first; the point is
    // that the stream is known even though this host has no process runtime.
    expect(await raw.next((frame) => frame.type === "snapshot" && frame.stream === stream)).toMatchObject({
      value: null,
    });
  });

  it("refuses a stopProcess without the capability", async () => {
    const { conversationId, raw } = await setup({
      processes: { load: () => Promise.reject(new Error("no prebuild")), diagnostic: () => {} },
    });
    expect(await raw.call("stopProcess", { conversationId, id: "whatever" })).toEqual({
      ok: false,
      error: "Background processes are unavailable on this host",
    });
  });
});
