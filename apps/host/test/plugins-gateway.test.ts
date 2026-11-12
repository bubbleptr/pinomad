// Plugins over the gateway (ADR-0049). Until plugins load, a host has none:
// hello carries no `plugins` and both plugin calls refuse the name.
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { connectTo, startChat, startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();

async function setup() {
  const host = await startFauxHost(defer, { answers: ["ok"] });
  const conversationId = await startChat(await connectTo(defer, host), "hi");
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  const arrived = new Set<() => void>();
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as ServerFrame);
    for (const wake of arrived) wake();
  });
  await once(socket, "open");
  const next = (test: (frame: ServerFrame) => boolean) =>
    new Promise<ServerFrame>((resolve) => {
      const check = () => {
        const frame = frames.find(test);
        if (frame === undefined) return;
        arrived.delete(check);
        resolve(frame);
      };
      arrived.add(check);
      check();
    });
  let id = 0;
  const call = async (method: string, args: unknown) => {
    const callId = ++id;
    socket.send(JSON.stringify({ type: "call", id: callId, method, args }));
    const frame = await next((candidate) => candidate.type === "result" && candidate.id === callId);
    return frame.type === "result" && !frame.ok ? { ok: false, error: frame.error } : frame;
  };
  return { conversationId, next, call };
}

describe("gateway plugins", () => {
  it("leaves hello.plugins out when the host has no plugins", async () => {
    const { next } = await setup();
    expect(await next((frame) => frame.type === "hello")).not.toHaveProperty("plugins");
  });

  it("refuses both plugin calls for a plugin it does not have", async () => {
    const { conversationId, call } = await setup();
    expect(await call("pluginBundle", { name: "artifact" })).toEqual({ ok: false, error: "Unknown plugin artifact" });
    expect(await call("pluginCall", { conversationId, plugin: "artifact", method: "open", args: null })).toEqual({
      ok: false,
      error: "Unknown plugin artifact",
    });
  });
});
