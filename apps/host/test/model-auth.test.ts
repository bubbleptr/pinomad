import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL, type ServerFrame } from "@pinomad/protocol/frames.ts";
import { watchModelAuth } from "../src/model-auth.ts";
import { startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();

const ANTHROPIC_KEY = { anthropic: { type: "api_key", key: "sk-ant-test" } };

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(initialAuth?: Record<string, unknown>): Promise<{ authPath: string; runtime: ModelRuntime }> {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-model-auth-"));
  defer(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  if (initialAuth !== undefined) await writeFile(authPath, JSON.stringify(initialAuth));
  // Offline: no models.json (in-memory store), no catalog refresh over the network.
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
  return { authPath, runtime };
}

describe("watchModelAuth", () => {
  it("republishes models and auth when auth.json is written externally", async () => {
    const { authPath, runtime } = await fixture();
    const modelAuth = await watchModelAuth(runtime, { authPath, debounceMs: 20 });
    defer(() => modelAuth.close());
    expect(modelAuth.auth.value.logins).toEqual([]);
    expect(modelAuth.models.value).toEqual([]);

    // A Pi CLI login lands as a plain auth.json write on this machine.
    await writeFile(authPath, JSON.stringify(ANTHROPIC_KEY));
    await until(() => modelAuth.auth.value.logins.length > 0);
    expect(modelAuth.auth.value).toEqual({
      logins: [{ providerId: "anthropic", name: "Anthropic", kind: "api_key", subscription: false }],
    });
    await until(() => modelAuth.models.value.some((model) => model.provider === "anthropic"));
  });

  it("logout drops the credential from auth.json and republishes immediately", async () => {
    // Written before create: the runtime's initial availability pass already
    // sees it, so no watcher round-trip is in play.
    const { authPath, runtime } = await fixture(ANTHROPIC_KEY);
    const modelAuth = await watchModelAuth(runtime, { authPath, debounceMs: 20 });
    defer(() => modelAuth.close());
    expect(modelAuth.auth.value.logins.map((login) => login.providerId)).toEqual(["anthropic"]);
    expect(modelAuth.models.value.some((model) => model.provider === "anthropic")).toBe(true);

    await modelAuth.logout("anthropic");
    expect(modelAuth.auth.value.logins).toEqual([]);
    expect(modelAuth.models.value.some((model) => model.provider === "anthropic")).toBe(false);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({});

    await expect(modelAuth.logout("anthropic")).rejects.toThrow('No stored credential for provider "anthropic"');
  });

  it("serves static values and refuses logout when the gateway has no modelAuth", async () => {
    const host = await startFauxHost(defer);
    const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
    defer(() => socket.terminate());
    const frames: ServerFrame[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    await once(socket, "open");
    for (const stream of ["models", "auth"]) socket.send(JSON.stringify({ type: "subscribe", stream }));
    socket.send(JSON.stringify({ type: "call", id: 1, method: "logout", args: { providerId: "anthropic" } }));
    await until(() =>
      frames.some((frame) => frame.type === "snapshot" && frame.stream === "models")
      && frames.some((frame) => frame.type === "snapshot" && frame.stream === "auth")
      && frames.some((frame) => frame.type === "result" && frame.id === 1),
    );
    expect(frames.find((frame) => frame.type === "hello")).toMatchObject({ protocol: PROTOCOL });
    expect(frames.find((frame) => frame.type === "snapshot" && frame.stream === "auth")).toMatchObject({
      value: { logins: [] },
    });
    const models = frames.find((frame) => frame.type === "snapshot" && frame.stream === "models")!;
    expect((models as { value: readonly unknown[] }).value.length).toBeGreaterThan(0);
    expect(frames.find((frame) => frame.type === "result" && frame.id === 1)).toMatchObject({
      ok: false,
      error: "Logging out is not available on this host",
    });
  });
});
