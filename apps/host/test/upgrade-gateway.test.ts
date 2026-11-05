// Upgrades over the gateway (ADR-0043): the `upgrade` stream, the calls, the
// real task graph as the "wait until idle" signal, and new work refused while
// npm runs. npm and the exit are fakes; nothing installs or exits.
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { HOST_UPGRADING_ERROR, type HostUpgrade } from "@pinomad/protocol/upgrade.ts";
import type { InstallResult } from "../src/upgrade/upgrader.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, useCleanups } from "./support.ts";

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
    for (const waiter of waiters.filter((w) => w.test(frame))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  await once(socket, "open");
  defer(() => socket.terminate());
  const nextFrame = (test: (frame: ServerFrame) => boolean) =>
    new Promise<ServerFrame>((resolve) => {
      const seen = frames.find(test);
      if (seen !== undefined) resolve(seen);
      else waiters.push({ test, resolve });
    });
  return {
    call: (method: string, args: unknown) =>
      new Promise<Result>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "call", id, method, args }));
      }),
    /** Subscribes to `upgrade` and resolves with the first value that passes `test`. */
    upgrade: async (test: (value: HostUpgrade) => boolean): Promise<HostUpgrade> => {
      if (!frames.some((frame) => frame.type === "snapshot" && frame.stream === "upgrade")) {
        socket.send(JSON.stringify({ type: "subscribe", stream: "upgrade" }));
      }
      const frame = await nextFrame((f) => f.type === "snapshot" && f.stream === "upgrade" && test(f.value as HostUpgrade));
      return (frame as { value: HostUpgrade }).value;
    },
  };
}

/** An install that finishes when the test says so. */
function heldInstall() {
  const calls: string[] = [];
  let finish: (result: InstallResult) => void = () => {};
  const install = (version: string) =>
    new Promise<InstallResult>((resolve) => {
      calls.push(version);
      finish = resolve;
    });
  return { calls, install, finish: (result: InstallResult) => finish(result) };
}

const RELEASE = { version: "0.14.0", publishedAt: Date.UTC(2026, 9, 1), protocolMajor: 5 };

async function upgradableHost(options: { install?: (version: string) => Promise<InstallResult>; answers?: string[]; tokensPerSecond?: number } = {}) {
  const restart = vi.fn();
  const host = await startFauxHost(defer, {
    answers: options.answers ?? ["hello"],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
    upgrade: {
      current: "0.13.0",
      restart,
      blocked: async () => null,
      latest: async () => RELEASE,
      install: options.install ?? (async () => ({ ok: true })),
      every: () => () => {},
    },
  });
  return { host, restart };
}

describe("gateway upgrades", () => {
  it("reports a source host as blocked and refuses the calls", async () => {
    const host = await startFauxHost(defer, { answers: ["hello"] });
    const raw = await rawClient(host);
    expect(await raw.upgrade(() => true)).toMatchObject({ blocked: "source", available: null, phase: "idle" });
    expect(await raw.call("startUpgrade", { when: "now" })).toMatchObject({ ok: false });
  });

  it("streams the available release and restarts after a successful install", async () => {
    const { host, restart } = await upgradableHost();
    const raw = await rawClient(host);
    expect(await raw.upgrade((value) => value.available !== null)).toMatchObject({
      current: "0.13.0",
      available: { version: "0.14.0", crossesMajor: false },
      blocked: null,
    });
    expect(await raw.call("startUpgrade", { when: "idle" })).toEqual({ ok: true, value: null });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  });

  it("refuses new work while installing and takes it again after a failure", async () => {
    const held = heldInstall();
    const { host, restart } = await upgradableHost({ install: held.install });
    const durable = await connectTo(defer, host);
    const conversationId = await startChat(durable, "hi");
    const raw = await rawClient(host);
    await raw.upgrade((value) => value.available !== null);
    await raw.call("startUpgrade", { when: "now" });
    await raw.upgrade((value) => value.phase === "installing");

    const submit = { conversationId, text: "again", whenBusy: "followUp", requestId: "r-upgrading" };
    expect(await raw.call("submit", submit)).toEqual({ ok: false, error: HOST_UPGRADING_ERROR });

    held.finish({ ok: false, message: "npm ERR! code E404" });
    expect(await raw.upgrade((value) => value.failure !== null)).toMatchObject({
      phase: "idle",
      failure: { version: "0.14.0", message: "npm ERR! code E404" },
    });
    expect(await raw.call("submit", { ...submit, requestId: "r-after" })).toMatchObject({ ok: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it("waits for a running turn before installing", async () => {
    const held = heldInstall();
    const { host } = await upgradableHost({ install: held.install, answers: [LONG_ANSWER], tokensPerSecond: 20 });
    const durable = await connectTo(defer, host);
    await startChat(durable, "hi");
    const raw = await rawClient(host);
    await raw.upgrade((value) => value.available !== null);
    await raw.call("startUpgrade", { when: "idle" });
    expect(await raw.upgrade((value) => value.phase === "waiting")).toMatchObject({ target: "0.14.0" });
    expect(held.calls).toEqual([]);
    await raw.upgrade((value) => value.phase === "installing");
    expect(held.calls).toEqual(["0.14.0"]);
  }, 20_000);

  it("cancels a wait", async () => {
    const { host } = await upgradableHost({ answers: [LONG_ANSWER], tokensPerSecond: 20 });
    const durable = await connectTo(defer, host);
    await startChat(durable, "hi");
    const raw = await rawClient(host);
    await raw.upgrade((value) => value.available !== null);
    await raw.call("startUpgrade", { when: "idle" });
    await raw.upgrade((value) => value.phase === "waiting");
    expect(await raw.call("cancelUpgrade", {})).toEqual({ ok: true, value: null });
    expect(await raw.upgrade((value) => value.phase === "idle" && value.target === null)).toMatchObject({ phase: "idle" });
  });

  it("refuses a manual check once autoUpgrade is off", async () => {
    const { host } = await upgradableHost();
    const raw = await rawClient(host);
    expect(await raw.call("updateSettings", { patch: { autoUpgrade: "off" } })).toMatchObject({ ok: true });
    expect(await raw.call("checkUpgrade", {})).toMatchObject({ ok: false });
  });
});
