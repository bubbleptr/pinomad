// Plugins over the gateway (ADR-0049, ADR-0050). A host loads `<dataDir>/plugins/*`
// at startup and reloads a plugin when its files change; without plugins hello
// carries no `plugins` and both plugin calls refuse the name.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { transcript } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { todo } from "../src/extensions/todo.ts";
import type { OpenedHost } from "../src/host.ts";
import type { PluginReload } from "../src/plugins.ts";
import { connectTo, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const FIXTURE = fileURLToPath(new URL("./fixtures/plugins/notes", import.meta.url));
const ARTIFACT_EXAMPLE = fileURLToPath(new URL("../../../examples/plugins/artifact", import.meta.url));
const BOARD = "plugin.notes.board";
const WRITES = "plugin.notes.writes";

/** Write plugin `name` under `dataDir`: a package.json naming it, plus `files`. */
async function writePlugin(dataDir: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = join(dataDir, "plugins", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
}

/** A data dir holding the `notes` fixture plugin, plus any extra plugins. */
async function dataDirWithPlugins(extra: Record<string, Record<string, string>> = {}): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  await cp(FIXTURE, join(dir.path, "plugins", "notes"), { recursive: true });
  for (const [name, files] of Object.entries(extra)) await writePlugin(dir.path, name, files);
  return dir.path;
}

/** A server half registering one tool named `tool`. */
const oneTool = (tool: string): string =>
  `import { definePlugin } from "@pinomad/plugin/v1";\n` +
  `export default definePlugin((p) => { p.tool({ name: "${tool}", description: "x", parameters: { type: "object" }, run: async () => ({ text: "" }) }); });\n`;

type HostOptions = NonNullable<Parameters<typeof startFauxHost>[1]>;

/** Reload outcomes and plugin log lines as they arrive; `next` takes the first unconsumed outcome matching `test`. */
function pluginEvents() {
  const outcomes: PluginReload[] = [];
  /** Every outcome, never consumed. */
  const history: PluginReload[] = [];
  const log: string[] = [];
  const waiting = new Set<() => void>();
  const wake = () => {
    for (const check of [...waiting]) check();
  };
  return {
    log,
    history,
    options: {
      onReload: (outcome: PluginReload) => {
        outcomes.push(outcome);
        history.push(outcome);
        wake();
      },
      log: (line: string) => {
        log.push(line);
        wake();
      },
    } satisfies HostOptions["plugins"],
    next: (test: (outcome: PluginReload) => boolean): Promise<PluginReload> =>
      new Promise((resolve) => {
        const check = () => {
          const index = outcomes.findIndex(test);
          if (index === -1) return;
          const [found] = outcomes.splice(0, index + 1).slice(-1);
          waiting.delete(check);
          resolve(found!);
        };
        waiting.add(check);
        check();
      }),
  };
}

async function setup(options: Pick<HostOptions, "dataDir" | "answers" | "extensions" | "plugins"> = {}) {
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
  const hello = async () => {
    const frame = await next((candidate) => candidate.type === "hello");
    if (frame.type !== "hello") throw new Error("unreachable");
    return frame;
  };
  return { next, call, subscribe, hello };
}

const toolResults = (view: DurableView): string[] =>
  view.conversation!.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));

const board = (view: DurableView) => view.docs.find((doc) => doc.kind === BOARD)?.value as { notes: string[] } | null | undefined;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("gateway plugins", () => {
  it("leaves hello.plugins out when the host has no plugins", async () => {
    const { hello } = await setup();
    expect(await hello()).not.toHaveProperty("plugins");
  });

  it("refuses both plugin calls for a plugin it does not have", async () => {
    const { conversationId, call } = await setup();
    expect(await call("pluginBundle", { name: "artifact" })).toEqual({ ok: false, error: "Unknown plugin artifact" });
    expect(await call("pluginCall", { conversationId, plugin: "artifact", method: "open", args: null })).toEqual({
      ok: false,
      error: "Unknown plugin artifact",
    });
  });

  it("announces a loaded plugin with the digest of the bundle it serves, and only its shared state", async () => {
    const { hello, call } = await setup({ dataDir: await dataDirWithPlugins() });
    const frame = await hello();
    const bundle = await call("pluginBundle", { name: "notes" });
    const code = (bundle.value as { code: string }).code;
    expect(frame.plugins).toEqual([{ name: "notes", api: 1, web: { hash: sha256(code), size: Buffer.byteLength(code) } }]);
    const kinds = frame.docs.map((doc) => doc.kind);
    expect(kinds).toContain(BOARD);
    expect(kinds).not.toContain(WRITES);
  });

  it("runs a method that writes shared and host-only state", async () => {
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
    const events = pluginEvents();
    const dataDir = await dataDirWithPlugins({ shadow: { "server.ts": oneTool("todo_write") } });
    const { hello } = await setup({ dataDir, extensions: [todo], plugins: events.options });
    expect((await hello()).plugins?.map((plugin) => plugin.name)).toEqual(["notes"]);
    expect(events.log.join("\n")).toMatch(/shadow.*todo_write/);
  });

  it("runs the artifact example: the tool replaces the page, the method returns it, and the page stays on the host", async () => {
    const dataDir = await tempDir();
    defer(dataDir.remove);
    await cp(ARTIFACT_EXAMPLE, join(dataDir.path, "plugins", "artifact"), { recursive: true });
    const write = (title: string, html: string) =>
      fauxAssistantMessage(fauxToolCall("artifact_write", { title, html }), { stopReason: "toolUse" });
    const { client, conversationId, hello } = await setup({
      dataDir: dataDir.path,
      answers: [write("Draft", "<p>first</p>"), write("Clock", "<p>second</p>"), "done"],
    });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "done");

    expect(await client.plugins.call(conversationId, "artifact", "read", null)).toEqual({ title: "Clock", html: "<p>second</p>" });
    expect((await hello()).plugins?.map((plugin) => plugin.name)).toEqual(["artifact"]);
    // Clients see that the page changed, never the page itself.
    const shared = (view: DurableView) => view.docs.filter((doc) => doc.kind.startsWith("plugin.artifact.") && doc.value != null);
    await waitForView(client.view, (view) => JSON.stringify(shared(view)).includes("Clock"));
    expect(JSON.stringify(shared(client.view.current()))).not.toContain("<p>");
  });

  it("skips broken plugins, says how to move an old plugin.json directory, and still loads the good one", async () => {
    const events = pluginEvents();
    const dataDir = await dataDirWithPlugins({
      throws: { "server.ts": 'import { definePlugin } from "@pinomad/plugin/v1";\nexport default definePlugin(() => { throw new Error("boom"); });\n' },
      bare: { "server.ts": "export default () => {};\n" },
      // Sorted after `notes`, so it is the one whose tool name collides.
      "zz-clash": { "server.ts": oneTool("notes_add") },
    });
    await mkdir(join(dataDir, "plugins", "legacy"));
    await writeFile(join(dataDir, "plugins", "legacy", "plugin.json"), JSON.stringify({ name: "legacy", api: 1, host: "host.ts" }));
    const { hello, call } = await setup({ dataDir, plugins: events.options });
    expect((await hello()).plugins?.map((plugin) => plugin.name)).toEqual(["notes"]);
    expect(await call("pluginBundle", { name: "throws" })).toEqual({ ok: false, error: "Unknown plugin throws" });
    const log = events.log.join("\n");
    expect(log).toMatch(/throws.*boom/);
    expect(log).toMatch(/bare.*default export/);
    expect(log).toMatch(/zz-clash.*notes_add/);
    expect(log).toMatch(/legacy.*plugin\.json.*package\.json/);
  });
});

/** The counter plugin; `version` is baked into what its tool writes and returns. Gated through `globalThis`. */
const counter = (version: string, extra = ""): string => `
import { definePlugin } from "@pinomad/plugin/v1";
const test = globalThis as { __pluginEnter?: (version: string) => void; __pluginGate?: Promise<void> };
export default definePlugin((pinomad) => {
  const count = pinomad.state("count", { version: 1, initial: () => ({ n: 0, by: [] as string[] }) });
  pinomad.tool({
    name: "counter_bump",
    description: "Add one to the counter.",
    parameters: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      test.__pluginEnter?.("${version}");
      await test.__pluginGate;
      let n = 0;
      await ctx.change(async (tx) => {
        const doc = await tx.get(count);
        doc.n += 1;
        doc.by.push("${version}");
        n = doc.n;
      });
      return { text: "${version} counted " + n };
    },
  });
  pinomad.method("peek", async (_args, ctx) => ctx.read(count));
  ${extra}
});
`;

const bump = () => fauxAssistantMessage(fauxToolCall("counter_bump", {}), { stopReason: "toolUse" });

describe("plugin reload", () => {
  const test = globalThis as { __pluginEnter?: (version: string) => void; __pluginGate?: Promise<void> };
  afterEach(() => {
    delete test.__pluginEnter;
    delete test.__pluginGate;
  });

  async function counterHost(answers: HostOptions["answers"], extra: Partial<HostOptions> = {}) {
    const dir = await tempDir();
    defer(dir.remove);
    await writePlugin(dir.path, "counter", { "server.ts": counter("v1") });
    const events = pluginEvents();
    const opened = await setup({ dataDir: dir.path, answers, plugins: events.options, ...extra });
    const lastText = (text: string) => waitForView(opened.client.view, (view) => transcript(view.conversation!).at(-1)?.text === text);
    const results = () => toolResults(opened.client.view.current());
    return { ...opened, dataDir: dir.path, events, lastText, results, edit: (source: string) => writePlugin(dir.path, "counter", { "server.ts": source }) };
  }

  it("runs the next tool call on the edited code, lets the running call finish on the old code, and keeps the plugin's state", async () => {
    const { client, conversationId, call, events, lastText, results, edit } = await counterHost([bump(), "one", bump(), "two", bump(), "three"]);
    await lastText("one");
    expect(results()[0]).toContain("v1 counted 1");

    let release!: () => void;
    test.__pluginGate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<string>((resolve) => (test.__pluginEnter = resolve));
    await client.controller.submit("again", "followUp");
    expect(await entered).toBe("v1");

    await edit(counter("v2"));
    expect((await events.next((outcome) => outcome.changed.includes("counter"))).failed).toEqual([]);
    release();
    await lastText("two");
    expect(results()[1]).toContain("v1 counted 2");

    await client.controller.submit("third", "followUp");
    await lastText("three");
    expect(results()[2]).toContain("v2 counted 3");
    expect(await call("pluginCall", { conversationId, plugin: "counter", method: "peek", args: null })).toEqual({
      ok: true,
      value: { n: 3, by: ["v1", "v1", "v2"] },
    });
  });

  it("keeps the last good version when an edit does not build, logs why, and recovers when it is fixed", async () => {
    const { client, events, lastText, results, edit } = await counterHost([bump(), "one", bump(), "two", bump(), "three"]);
    await lastText("one");

    await edit(`${counter("v2")}\nexport const broken = (;\n`);
    const failed = await events.next((outcome) => outcome.failed.length > 0);
    const since = events.history.length;
    expect(failed.failed.map((failure) => failure.plugin)).toEqual(["counter"]);
    expect(events.log.join("\n")).toMatch(/counter[\s\S]*server\.ts/);
    await client.controller.submit("again", "followUp");
    await lastText("two");
    expect(results()[1]).toContain("v1 counted 2");

    await edit(counter("v3"));
    await events.next((outcome) => outcome.changed.includes("counter"));
    // Nothing was retried in a loop while the plugin stayed broken: the fix is the only reload since.
    expect(events.history.slice(since)).toHaveLength(1);
    await client.controller.submit("third", "followUp");
    await lastText("three");
    expect(results()[2]).toContain("v3 counted 3");
  });

  it("refuses a reload that takes a built-in tool's name and keeps the plugin as it was", async () => {
    const { client, events, lastText, results, edit, hello } = await counterHost([bump(), "one", bump(), "two"], {
      extensions: [todo],
    });
    await lastText("one");
    await edit(counter("v2", `pinomad.tool({ name: "todo_write", description: "x", parameters: { type: "object" }, run: async () => ({ text: "" }) });`));
    const failed = await events.next((outcome) => outcome.failed.length > 0);
    expect(failed.failed[0]?.error).toMatch(/todo_write/);
    await client.controller.submit("again", "followUp");
    await lastText("two");
    expect(results()[1]).toContain("v1 counted 2");
    expect((await hello()).plugins?.map((plugin) => plugin.name)).toEqual(["counter"]);
  });

  it("drops a removed plugin's tool and announcement, and picks up a plugin added while the host runs", async () => {
    const { host, client, dataDir, events, lastText, results } = await counterHost([
      bump(),
      "one",
      bump(),
      "two",
      fauxAssistantMessage(fauxToolCall("added_ping", {}), { stopReason: "toolUse" }),
      "three",
    ]);
    await lastText("one");
    await rm(join(dataDir, "plugins", "counter"), { recursive: true });
    await events.next((outcome) => outcome.removed.includes("counter"));
    await client.controller.submit("again", "followUp");
    await lastText("two");
    expect(results()[1]).toContain('"isError":true');
    expect((await (await rawSocket(host)).hello()).plugins).toBeUndefined();

    await writePlugin(dataDir, "added", {
      "server.ts":
        'import { definePlugin } from "@pinomad/plugin/v1";\n' +
        'export default definePlugin((p) => { p.tool({ name: "added_ping", description: "x", parameters: { type: "object" }, run: async () => ({ text: "pong" }) }); });\n',
    });
    await events.next((outcome) => outcome.added.includes("added"));
    await client.controller.submit("third", "followUp");
    await lastText("three");
    expect(results()[2]).toContain("pong");
    expect((await (await rawSocket(host)).hello()).plugins?.map((plugin) => plugin.name)).toEqual(["added"]);
  });

  it("loads a plugin directory linked from elsewhere and reloads it when a file in the checkout changes", async () => {
    const checkout = await tempDir();
    defer(checkout.remove);
    await writePlugin(checkout.path, "counter", { "server.ts": counter("v1") });
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "plugins"));
    await symlink(join(checkout.path, "plugins", "counter"), join(dir.path, "plugins", "counter"));
    const events = pluginEvents();
    const { client } = await setup({ dataDir: dir.path, answers: [bump(), "one", bump(), "two"], plugins: events.options });
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "one");
    expect(toolResults(client.view.current())[0]).toContain("v1 counted 1");

    await writePlugin(checkout.path, "counter", { "server.ts": counter("v2") });
    await events.next((outcome) => outcome.changed.includes("counter"));
    await client.controller.submit("again", "followUp");
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "two");
    expect(toolResults(client.view.current())[1]).toContain("v2 counted 2");
  });

  it("announces a new bundle digest after the web half changes, while an open connection still gets the bundle it was told about", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const web = (label: string) => `export default function (pinomad) { pinomad.panel({ id: "p", label: "${label}", component: () => null }); }\n`;
    await writePlugin(dir.path, "panel", { "web.js": web("One") });
    const events = pluginEvents();
    const { host, hello, call } = await setup({ dataDir: dir.path, plugins: events.options });
    const before = (await hello()).plugins![0]!.web!;
    const first = ((await call("pluginBundle", { name: "panel" })).value as { code: string }).code;
    expect(sha256(first)).toBe(before.hash);

    await writePlugin(dir.path, "panel", { "web.js": web("Two") });
    await events.next((outcome) => outcome.changed.includes("panel"));
    const later = await rawSocket(host);
    const after = (await later.hello()).plugins![0]!.web!;
    expect(after.hash).not.toBe(before.hash);
    const second = ((await later.call("pluginBundle", { name: "panel" })).value as { code: string }).code;
    expect(sha256(second)).toBe(after.hash);
    expect(second).toContain("Two");
    // The connection opened before the edit keeps getting what its hello announced.
    expect(((await call("pluginBundle", { name: "panel" })).value as { code: string }).code).toBe(first);
  });
});
