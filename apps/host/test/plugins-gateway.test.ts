// Plugins over the gateway (ADR-0049). A host loads `<dataDir>/plugins/*` at
// startup; without that directory hello carries no `plugins` and both plugin
// calls refuse the name.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { todo } from "../src/extensions/todo.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const FIXTURE = fileURLToPath(new URL("./fixtures/plugins/notes", import.meta.url));
const BOARD = "plugin.notes.board";
const WRITES = "plugin.notes.writes";

/** A data dir holding the `notes` fixture plugin, plus any extra plugin files by relative path. */
async function dataDirWithPlugins(extra: Record<string, string> = {}): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  await cp(FIXTURE, join(dir.path, "plugins", "notes"), { recursive: true });
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(join(dir.path, "plugins", path, ".."), { recursive: true });
    await writeFile(join(dir.path, "plugins", path), content);
  }
  return dir.path;
}

type HostOptions = NonNullable<Parameters<typeof startFauxHost>[1]>;

async function setup(options: Pick<HostOptions, "dataDir" | "answers" | "extensions"> = {}) {
  const host = await startFauxHost(defer, { ...options, answers: options.answers ?? ["ok"] });
  const client = await connectTo(defer, host);
  const conversationId = await startChat(client, "hi");
  return { host, client, conversationId, ...(await rawSocket(host)) };
}

async function rawSocket(host: OpenedHost) {
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
    if (frame.type !== "result") throw new Error("unreachable");
    return frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error };
  };
  const subscribe = (stream: string) => socket.send(JSON.stringify({ type: "subscribe", stream }));
  return { next, call, subscribe };
}

const toolResults = (view: DurableView): string[] =>
  view.conversation!.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));

const board = (view: DurableView) => view.docs.find((doc) => doc.kind === BOARD)?.value as { notes: string[] } | null | undefined;

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

  it("announces a loaded plugin, its bundle digest and only its shared state", async () => {
    const { next } = await setup({ dataDir: await dataDirWithPlugins() });
    const bytes = await readFile(join(FIXTURE, "web.js"));
    const hello = await next((frame) => frame.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.plugins).toEqual([
      { name: "notes", api: 1, web: { hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } },
    ]);
    const kinds = hello.docs.map((doc) => doc.kind);
    expect(kinds).toContain(BOARD);
    expect(kinds).not.toContain(WRITES);
  });

  it("runs a method that writes shared and host-only state, and serves the bundle", async () => {
    const { client, conversationId, call, next, subscribe } = await setup({ dataDir: await dataDirWithPlugins() });

    expect(await call("pluginCall", { conversationId, plugin: "notes", method: "add", args: "first" })).toEqual({
      ok: true,
      value: { writes: 1 },
    });
    expect(await call("pluginCall", { conversationId, plugin: "notes", method: "add", args: "second" })).toEqual({
      ok: true,
      value: { writes: 2 },
    });
    await waitForView(client.view, (view) => board(view)?.notes.length === 2);
    expect(board(client.view.current())).toEqual({ notes: ["first", "second"] });

    // The host-only state is not a stream.
    subscribe(`doc:${WRITES}:${conversationId}`);
    expect(await next((frame) => frame.type === "ended" && frame.stream === `doc:${WRITES}:${conversationId}`)).toMatchObject({
      reason: `Unknown document ${WRITES}`,
    });

    expect(await call("pluginBundle", { name: "notes" })).toEqual({
      ok: true,
      value: { code: await readFile(join(FIXTURE, "web.js"), "utf8") },
    });
  });

  it("fails only the call when a method is unknown, throws, or names a missing conversation", async () => {
    const { conversationId, call } = await setup({ dataDir: await dataDirWithPlugins() });
    expect(await call("pluginCall", { conversationId, plugin: "notes", method: "nope", args: null })).toEqual({
      ok: false,
      error: "Unknown method nope on plugin notes",
    });
    expect(await call("pluginCall", { conversationId, plugin: "notes", method: "fail", args: null })).toEqual({
      ok: false,
      error: "plugin method failed",
    });
    expect(await call("pluginCall", { conversationId: 999_999, plugin: "notes", method: "add", args: "x" })).toEqual({
      ok: false,
      error: "Conversation 999999 does not exist",
    });
    expect(await call("pluginCall", { conversationId, plugin: "notes", method: "add", args: "still works" })).toEqual({
      ok: true,
      value: { writes: 1 },
    });
  });

  it("offers the plugin's tool to the model and returns its text", async () => {
    const offered: string[][] = [];
    const callTool: FauxResponseFactory = async (request) => {
      // pi-messages carries the tool set as transcript changes (`toolsAdded`).
      const messages = request.messages as readonly { toolsAdded?: readonly { name: string }[] }[];
      offered.push(messages.flatMap((message) => message.toolsAdded?.map((tool) => tool.name) ?? []));
      return fauxAssistantMessage(fauxToolCall("notes_add", { text: "from the model" }), { stopReason: "toolUse" });
    };
    const { client } = await setup({ dataDir: await dataDirWithPlugins(), answers: [callTool, "done"] });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "done");
    expect(offered[0]).toEqual(expect.arrayContaining(["notes_add", "notes_fail"]));
    expect(board(client.view.current())).toEqual({ notes: ["from the model"] });
    expect(toolResults(client.view.current()).some((text) => text.includes("Added note 1"))).toBe(true);
  });

  it("turns a throwing tool into an error result and carries on", async () => {
    const { client } = await setup({
      dataDir: await dataDirWithPlugins(),
      answers: [fauxAssistantMessage(fauxToolCall("notes_fail", {}), { stopReason: "toolUse" }), "recovered"],
    });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "recovered");
    const [result] = toolResults(client.view.current());
    expect(result).toContain("notes tool failed");
    expect(result).toContain('"isError":true');
  });

  it("skips a plugin whose tool name a built-in extension already uses", async () => {
    const dataDir = await dataDirWithPlugins({
      "shadow/plugin.json": JSON.stringify({ name: "shadow", api: 1, host: "host.ts" }),
      "shadow/host.ts":
        'export default (p) => { p.tool({ name: "todo_write", description: "x", parameters: { type: "object" }, run: async () => ({ text: "" }) }); };\n',
    });
    const { next } = await setup({ dataDir, extensions: [todo] });
    const hello = await next((frame) => frame.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.plugins?.map((plugin) => plugin.name)).toEqual(["notes"]);
  });

  it("skips broken plugins and still loads the good one", async () => {
    const dataDir = await dataDirWithPlugins({
      "throws/plugin.json": JSON.stringify({ name: "throws", api: 1, host: "host.ts" }),
      "throws/host.ts": 'export default () => { throw new Error("boom"); };\n',
      "misnamed/plugin.json": JSON.stringify({ name: "other", api: 1 }),
      "escapes/plugin.json": JSON.stringify({ name: "escapes", api: 1, web: "../notes/web.js" }),
      // Sorted after `notes`, so it is the one whose tool name collides.
      "zz-clash/plugin.json": JSON.stringify({ name: "zz-clash", api: 1, host: "host.ts" }),
      "zz-clash/host.ts":
        'export default (p) => { p.tool({ name: "notes_add", description: "x", parameters: { type: "object" }, run: async () => ({ text: "" }) }); };\n',
    });
    const { next, call } = await setup({ dataDir });
    const hello = await next((frame) => frame.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.plugins?.map((plugin) => plugin.name)).toEqual(["notes"]);
    expect(await call("pluginBundle", { name: "throws" })).toEqual({ ok: false, error: "Unknown plugin throws" });
  });
});
