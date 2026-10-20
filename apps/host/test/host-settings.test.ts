import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { normalizeHostName, type HostSettings } from "@pinomad/protocol/settings.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { constantValue, Published } from "../src/host-value.ts";
import { openHostSettings, type SettingsFallback } from "../src/host-settings.ts";
import { connectTo, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

const CATALOG: ModelSummary[] = [
  { provider: "pi", modelId: "pi-1", name: "Pi One", contextWindow: 128000, thinkingLevels: ["off"] },
];
const models = constantValue<readonly ModelSummary[]>(CATALOG);

// pi defaults, standing in for the settingsManager getters.
const fallback: SettingsFallback = {
  defaultModel: () => ({ provider: "pi", modelId: "pi-1" }),
  defaultThinkingLevel: () => "medium",
  steeringMode: () => "one-at-a-time",
  followUpMode: () => "all",
};

async function settingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-settings-"));
  defer(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "settings.json");
}

describe("openHostSettings", () => {
  it("inherits everything from the fallback when the file is missing, and creates nothing", async () => {
    const path = await settingsPath();
    const settings = await openHostSettings({ path, fallback, models });
    expect(settings.value).toEqual({
      defaultModel: { provider: "pi", modelId: "pi-1" },
      defaultThinkingLevel: "medium",
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      acceptAccountDevices: true,
      hostName: normalizeHostName(hostname()),
      custom: [],
    });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("writes updates to the file, publishes, lists the key in custom, and preserves unknown keys", async () => {
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ "future.key": { enabled: true } }));
    const settings = await openHostSettings({ path, fallback, models });
    const seen: HostSettings[] = [];
    settings.subscribe((value) => seen.push(value));

    await settings.update({ steeringMode: "all" });
    expect(settings.value.steeringMode).toBe("all");
    expect(settings.value.custom).toEqual(["steeringMode"]);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      "future.key": { enabled: true },
      steeringMode: "all",
    });
  });

  it("a null update removes the file key and returns to the fallback", async () => {
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ steeringMode: "all", "future.key": 1 }));
    const settings = await openHostSettings({ path, fallback, models });
    expect(settings.value.steeringMode).toBe("all");

    await settings.update({ steeringMode: null });
    expect(settings.value.steeringMode).toBe("one-at-a-time");
    expect(settings.value.custom).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "future.key": 1 });
  });

  it("refuses to start on invalid JSON, naming the path", async () => {
    const path = await settingsPath();
    await writeFile(path, "{not json");
    await expect(openHostSettings({ path, fallback, models })).rejects.toThrow(path);
  });

  it("warns once and ignores a known key with an invalid value", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    defer(() => warn.mockRestore());
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ steeringMode: "sometimes", followUpMode: "one-at-a-time" }));
    const models = new Published<readonly ModelSummary[]>(CATALOG, () => false);
    const settings = await openHostSettings({ path, fallback, models });
    // Malformed values warn once per key, even as later recomputes see them again.
    models.set([]);
    expect(settings.value.steeringMode).toBe("one-at-a-time");
    expect(settings.value.followUpMode).toBe("one-at-a-time");
    expect(settings.value.custom).toEqual(["followUpMode"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("steeringMode");
    expect(String(warn.mock.calls[0]![0])).toContain(path);
  });

  it("re-evaluates a file-set default model when the model list changes", async () => {
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ defaultModel: { provider: "pi", modelId: "pi-1" } }));
    const models = new Published<readonly ModelSummary[]>(CATALOG, () => false);
    const settings = await openHostSettings({
      path,
      fallback: { ...fallback, defaultModel: () => null },
      models,
    });
    expect(settings.value.defaultModel).toEqual({ provider: "pi", modelId: "pi-1" });
    expect(settings.value.custom).toEqual(["defaultModel"]);
    const seen: HostSettings[] = [];
    settings.subscribe((value) => seen.push(value));

    // The provider logged out: the stored model is no longer runnable, so the
    // effective value inherits — without a warning, it is runtime state.
    models.set([]);
    expect(settings.value.defaultModel).toBeNull();
    expect(settings.value.custom).toEqual([]);
    expect(seen).toHaveLength(1);

    models.set(CATALOG);
    expect(settings.value.defaultModel).toEqual({ provider: "pi", modelId: "pi-1" });
    expect(settings.value.custom).toEqual(["defaultModel"]);
    expect(seen).toHaveLength(2);
  });

  it("rejects a default model the host cannot run and leaves the file untouched", async () => {
    const path = await settingsPath();
    const settings = await openHostSettings({ path, fallback, models });
    await expect(settings.update({ defaultModel: { provider: "nope", modelId: "x" } })).rejects.toThrow(
      "Unknown model: nope/x",
    );
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("acceptAccountDevices defaults on, persists an explicit off, and resets to on", async () => {
    const path = await settingsPath();
    const settings = await openHostSettings({ path, fallback, models });
    const seen: boolean[] = [];
    settings.subscribe((value) => seen.push(value.acceptAccountDevices));

    await settings.update({ acceptAccountDevices: false });
    expect(settings.value.acceptAccountDevices).toBe(false);
    expect(settings.value.custom).toEqual(["acceptAccountDevices"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ acceptAccountDevices: false });

    await settings.update({ acceptAccountDevices: null });
    expect(settings.value.acceptAccountDevices).toBe(true);
    expect(settings.value.custom).toEqual([]);
    expect(seen).toEqual([false, true]);
  });

  it("names the host after its machine name until a device overrides it (5.12)", async () => {
    const path = await settingsPath();
    const settings = await openHostSettings({ path, fallback, models });
    expect(settings.value.hostName).toBe(normalizeHostName(hostname()));
    expect(settings.value.custom).toEqual([]);

    await settings.update({ hostName: "Desk" });
    expect(settings.value.hostName).toBe("Desk");
    expect(settings.value.custom).toEqual(["hostName"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hostName: "Desk" });

    // The override is explicit even when it lands on the machine name.
    await settings.update({ hostName: normalizeHostName(hostname()) });
    expect(settings.value.custom).toEqual(["hostName"]);

    await settings.update({ hostName: null });
    expect(settings.value.hostName).toBe(normalizeHostName(hostname()));
    expect(settings.value.custom).toEqual([]);
  });

  it("normalizes a file-set or patched hostName, and refuses a name with nothing to show", async () => {
    const path = await settingsPath();
    // A hand-edited value is tolerated: the effective name cleans it.
    await writeFile(path, JSON.stringify({ hostName: "dirty.local" }));
    const settings = await openHostSettings({ path, fallback, models });
    expect(settings.value.hostName).toBe("dirty");
    expect(settings.value.custom).toEqual(["hostName"]);

    // update writes the cleaned name: the file then holds what is displayed.
    await settings.update({ hostName: "desk.local" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hostName: "desk" });
    expect(settings.value.hostName).toBe("desk");

    await expect(settings.update({ hostName: "  " })).rejects.toThrow("Invalid host name");
    await expect(settings.update({ hostName: "" })).rejects.toThrow("Invalid host name");
    await expect(settings.update({ hostName: "" })).rejects.toThrow("Invalid host name");
    expect(settings.value.hostName).toBe("desk");
  });

  it("keeps a join-written key when the running host updates other settings (issue #212)", async () => {
    const path = await settingsPath();
    // A running host and the join CLI share the file, each holding its own
    // open-time snapshot. The host's next update must merge over the CLI's
    // write, not rewrite from the stale base.
    const running = await openHostSettings({ path, fallback, models });
    const joinCli = await openHostSettings({ path, fallback, models });
    await joinCli.update({ hostName: "joined-name" });

    await running.update({ followUpMode: "one-at-a-time" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      hostName: "joined-name",
      followUpMode: "one-at-a-time",
    });
    // The re-read republishes too: the join-written name is now effective.
    expect(running.value.hostName).toBe("joined-name");
  });

  it("keeps a client write that landed after the join CLI opened the file", async () => {
    const path = await settingsPath();
    const joinCli = await openHostSettings({ path, fallback, models });
    const running = await openHostSettings({ path, fallback, models });
    await running.update({ followUpMode: "one-at-a-time" });

    // The CLI's snapshot predates the client write — its update must not
    // drop the key it never saw.
    await joinCli.update({ hostName: "joined-name" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      followUpMode: "one-at-a-time",
      hostName: "joined-name",
    });
  });

  it("serializes concurrent updates so every one lands", async () => {
    const path = await settingsPath();
    const settings = await openHostSettings({ path, fallback, models });
    await Promise.all([
      settings.update({ steeringMode: "all" }),
      settings.update({ followUpMode: "one-at-a-time" }),
      settings.update({ defaultThinkingLevel: "high" }),
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      defaultThinkingLevel: "high",
    });
    expect(settings.value.custom).toEqual(["defaultThinkingLevel", "steeringMode", "followUpMode"]);
  });
});

describe("settings over the gateway", () => {
  it("pushes a device A update to device B and the next conversation uses it", async () => {
    const host = await startFauxHost(defer, {
      fauxModels: [
        { id: "faux-1", name: "Faux Model" },
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
      ],
      answers: ["done"],
    });
    const a = await connectTo(defer, host);
    const b = await connectTo(defer, host);

    await a.controller.updateSettings({
      defaultModel: { provider: "faux", modelId: "faux-thinker" },
      defaultThinkingLevel: "high",
    });
    await waitForView(b.view, (view) => view.settings?.defaultThinkingLevel === "high");
    expect(b.view.current().settings?.custom).toEqual(["defaultModel", "defaultThinkingLevel"]);
    expect(b.view.current().defaults).toEqual({
      model: { provider: "faux", modelId: "faux-thinker" },
      thinkingLevel: "high",
    });

    await a.controller.createConversation({ kind: "chat" }, "hello");
    const id = a.view.current().conversation!.conversation.id;
    const agent = await host.harness.snapshot(AgentDoc, id, context);
    expect(agent?.model).toEqual({ provider: "faux", modelId: "faux-thinker" });
    expect(agent?.thinkingLevel).toBe("high");
  });

  it("announces the host name on the settings stream and keeps a refused update harmless", async () => {
    const host = await startFauxHost(defer, { answers: [] });
    const a = await connectTo(defer, host);
    const b = await connectTo(defer, host);
    await waitForView(a.view, (view) => view.settings?.hostName === normalizeHostName(hostname()));

    await a.controller.updateSettings({ hostName: "Desk" });
    await waitForView(b.view, (view) => view.settings?.hostName === "Desk");
    expect(b.view.current().settings?.custom).toEqual(["hostName"]);

    // A name that cleans to nothing is refused — refused is ok:false, so the
    // connection must survive (a malformed patch would 4400 it). ".local " is
    // the double-clean case: pass one leaves ".local", the fixed point is "".
    await a.controller.updateSettings({ hostName: "  " });
    await a.controller.updateSettings({ hostName: ".local " });
    await waitForView(a.view, (view) => view.notices.some((n) => n.message.includes("Invalid host name")));
    expect(a.view.current().connection).toBe("connected");
    expect(b.view.current().settings?.hostName).toBe("Desk");
    // A double-suffix name stores its canonical form, not a first-pass value
    // the settings stream would then publish as something else.
    await a.controller.updateSettings({ hostName: "Bench.local.local" });
    await waitForView(b.view, (view) => view.settings?.hostName === "Bench");
  });

  it("keeps settings across a host restart on the same dataDir", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, { dataDir: dir.path });
    const client = await connectTo(defer, first);
    await client.controller.updateSettings({ steeringMode: "all" });
    await waitForView(client.view, (view) => view.settings?.steeringMode === "all");
    await first.close();

    const second = await startFauxHost(defer, { dataDir: dir.path });
    expect(second.settings.value.steeringMode).toBe("all");
    const reconnected = await connectTo(defer, second);
    expect(reconnected.view.current().settings?.steeringMode).toBe("all");
    expect(reconnected.view.current().settings?.custom).toEqual(["steeringMode"]);
  });
});
