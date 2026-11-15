// Credentials outside the agent (ADR-0052 §6): a plugin declares a secret, a
// client sets it write-only, and the plugin's tools use it in the host process.
// The agent opens a PR through the GitHub example plugin against a local fake
// API; the token reaches that API and nothing the agent or a client can read.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { coding } from "../src/extensions/coding.ts";
import { openSecretStore } from "../src/secrets.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const GITHUB_EXAMPLE = fileURLToPath(new URL("../../../examples/plugins/github", import.meta.url));
const TOKEN = "ghp_test0123456789abcdefSECRET";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const run = promisify(execFile);

/** Calls and frames over a raw socket, so the test sees every frame a client is sent. */
async function rawSocket(host: OpenedHost) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const raw: string[] = [];
  const frames: ServerFrame[] = [];
  const arrived = new Set<() => void>();
  socket.on("message", (data) => {
    raw.push(String(data));
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
  return { call, next, raw };
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A tiny GitHub: the REST calls the plugin makes, and a git endpoint that refuses every push. */
async function fakeGitHub() {
  const received: Received[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    received.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && request.url === "/api/repos/octo/demo/pulls") {
      return reply(201, { number: 7, html_url: "https://github.example/octo/demo/pull/7" });
    }
    if (request.method === "POST" && request.url === "/api/repos/octo/demo/issues/7/comments") {
      return reply(201, { html_url: "https://github.example/octo/demo/pull/7#issuecomment-1" });
    }
    if (request.url?.startsWith("/octo/demo.git/")) {
      response.writeHead(403);
      return response.end("push refused by the fake");
    }
    reply(404, { message: "Not Found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  defer(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { received, base };
}

/** Points the plugin at `base` for one test; the plugin reads these in the host process at each call. */
function useGitHubAt(base: string): void {
  const before = { api: process.env.GITHUB_API_URL, server: process.env.GITHUB_SERVER_URL };
  process.env.GITHUB_API_URL = `${base}/api`;
  process.env.GITHUB_SERVER_URL = base;
  restore.push(() => {
    for (const [key, value] of [["GITHUB_API_URL", before.api], ["GITHUB_SERVER_URL", before.server]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
const restore: (() => void)[] = [];
afterEach(() => {
  for (const each of restore.splice(0)) each();
});

/** A project that is a git repository with one commit. */
async function gitProject(): Promise<string> {
  const project = await tempDir();
  defer(project.remove);
  const git = (...args: string[]) => run("git", ["-C", project.path, ...args]);
  await git("init", "-q", "-b", "main");
  await writeFile(join(project.path, "README.md"), "demo\n");
  await git("add", ".");
  await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");
  return project.path;
}

const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });

describe("plugin secrets", () => {
  it("opens a PR through the GitHub plugin without the token reaching the agent or a client", async () => {
    const github = await fakeGitHub();
    useGitHubAt(github.base);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    await cp(GITHUB_EXAMPLE, join(dataDir.path, "plugins", "github"), { recursive: true });
    const project = await gitProject();
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [project],
      extensions: [coding],
      answers: [
        // What the agent's own processes see.
        call("bash", { command: "env" }),
        call("github_open_pr", { repo: "octo/demo", head: "feature", base: "main", title: "Add demo", body: "Opened by the agent." }),
        call("github_comment", { repo: "octo/demo", number: 7, body: "Ready for review." }),
        call("git_push", { repo: "octo/demo", branch: "feature" }),
        "done",
      ],
    });
    const socket = await rawSocket(host);

    const hello = await socket.next((frame) => frame.type === "hello");
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.plugins?.find((plugin) => plugin.name === "github")?.secrets).toEqual([
      { name: "github_token", description: expect.any(String), set: false },
    ]);
    expect(await socket.call("setPluginSecret", { plugin: "github", name: "github_token", value: TOKEN })).toEqual({ ok: true, value: null });
    // Every client learns that it is set, never the value.
    const told = await socket.next((frame) => frame.type === "plugins");
    if (told.type !== "plugins") throw new Error("unreachable");
    expect(told.plugins.find((plugin) => plugin.name === "github")?.secrets).toEqual([
      { name: "github_token", description: expect.any(String), set: true },
    ]);
    expect(await socket.call("setPluginSecret", { plugin: "github", name: "other", value: "x" })).toEqual({
      ok: false,
      error: "Plugin github has no secret other",
    });
    // Only the host can read the store.
    expect((await stat(join(dataDir.path, "secrets.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dataDir.path, "secrets.json"), "utf8")).toContain(TOKEN);

    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project }, "open a PR");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done");

    // The token reached GitHub, on every call.
    const api = github.received.filter((each) => each.url.startsWith("/api/"));
    expect(api.map((each) => `${each.method} ${each.url}`)).toEqual([
      "POST /api/repos/octo/demo/pulls",
      "POST /api/repos/octo/demo/issues/7/comments",
    ]);
    for (const each of api) expect(each.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(api[0]!.body)).toMatchObject({ title: "Add demo", head: "feature", base: "main", body: "Opened by the agent." });
    const push = github.received.filter((each) => each.url.startsWith("/octo/demo.git/"));
    expect(push.length).toBeGreaterThan(0);
    expect(push[0]!.authorization).toBe(`Basic ${BASIC}`);

    const entries = client.view.current().conversation!.entries;
    const results = entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));
    expect(results).toHaveLength(4);
    expect(results[0]).toContain("GITHUB_API_URL");
    expect(results[1]).toContain("https://github.example/octo/demo/pull/7");
    expect(results[2]).toContain("issuecomment-1");
    expect(results[3]).toMatch(/403/);
    // Nowhere the agent or a client can read: entries, results, frames, the agent's environment.
    for (const secret of [TOKEN, BASIC]) {
      expect(JSON.stringify(entries)).not.toContain(secret);
      expect(socket.raw.join("\n")).not.toContain(secret);
      expect(Object.values(process.env).join("\n")).not.toContain(secret);
    }
  });

  it("pushes without running the checkout's hooks or config with the token", async () => {
    const remotes = await tempDir();
    defer(remotes.remove);
    const bare = join(remotes.path, "octo", "demo.git");
    await run("git", ["init", "-q", "--bare", bare]);
    // file:// so the push succeeds without a server; the header is still handed to git.
    useGitHubAt(`file://${remotes.path}`);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    await cp(GITHUB_EXAMPLE, join(dataDir.path, "plugins", "github"), { recursive: true });
    const project = await gitProject();
    // What an agent could write into its own checkout to catch whatever runs there.
    const dump = join(remotes.path, "hook-env");
    await writeFile(join(project, ".git", "hooks", "pre-push"), `#!/bin/sh\nenv > "${dump}"\n`, { mode: 0o755 });
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [project],
      answers: [call("git_push", { repo: "octo/demo", branch: "feature" }), "done"],
    });
    const socket = await rawSocket(host);
    expect(await socket.call("setPluginSecret", { plugin: "github", name: "github_token", value: TOKEN })).toEqual({ ok: true, value: null });

    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project }, "push");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done");

    const results = client.view.current().conversation!.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));
    expect(results[0]).toContain("Pushed HEAD to octo/demo feature");
    const head = (await run("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim();
    expect((await run("git", ["--git-dir", bare, "rev-parse", "refs/heads/feature"])).stdout.trim()).toBe(head);
    // The git holding the token never ran the checkout's hook.
    await expect(stat(dump)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a plugin's secret out of what its tools return", async () => {
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const dir = join(dataDir.path, "plugins", "leaky");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "leaky" }));
    await writeFile(
      join(dir, "server.ts"),
      `import { definePlugin } from "@pinomad/plugin/v1";
export default definePlugin((p) => {
  const key = p.secret("api_key", { description: "The key." });
  p.tool({ name: "leak_text", description: "x", parameters: { type: "object" }, run: async (_args, ctx) => ({ text: "key=" + (await ctx.secret(key)) }) });
  p.tool({ name: "leak_error", description: "x", parameters: { type: "object" }, run: async (_args, ctx) => { throw new Error("failed with " + (await ctx.secret(key))); } });
});
`,
    );
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      answers: [call("leak_text", {}), call("leak_error", {}), "done"],
    });
    const socket = await rawSocket(host);
    expect(await socket.call("setPluginSecret", { plugin: "leaky", name: "api_key", value: TOKEN })).toEqual({ ok: true, value: null });

    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "chat" }, "go");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done");

    const results = client.view.current().conversation!.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));
    expect(results[0]).toContain("key=[redacted]");
    expect(results[1]).toContain("failed with [redacted]");
    expect(results.join("\n")).not.toContain(TOKEN);

    // Cleared, the secret reads as unset.
    expect(await socket.call("setPluginSecret", { plugin: "leaky", name: "api_key", value: null })).toEqual({ ok: true, value: null });
    expect(await readFile(join(dataDir.path, "secrets.json"), "utf8")).not.toContain(TOKEN);
  });

  it("redacts the value a tool read even when the secret is cleared before it returns", async () => {
    // The tool reads the secret, then waits on this server; the test clears the secret meanwhile.
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      const gate = createServer((_request, response) => {
        release = () => response.end("go");
        resolve();
      });
      gate.listen(0, "127.0.0.1", () => {
        process.env.PINOMAD_TEST_GATE = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
      });
      defer(() => new Promise<void>((done) => gate.close(() => done())));
    });
    restore.push(() => delete process.env.PINOMAD_TEST_GATE);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const dir = join(dataDir.path, "plugins", "slow");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "slow" }));
    await writeFile(
      join(dir, "server.ts"),
      `import { definePlugin } from "@pinomad/plugin/v1";
export default definePlugin((p) => {
  const key = p.secret("api_key", { description: "The key." });
  p.tool({ name: "slow_leak", description: "x", parameters: { type: "object" }, run: async (_args, ctx) => {
    const value = await ctx.secret(key);
    await (await fetch(process.env.PINOMAD_TEST_GATE)).text();
    return { text: "key=" + value };
  } });
});
`,
    );
    const host = await startFauxHost(defer, { dataDir: dataDir.path, answers: [call("slow_leak", {}), "done"] });
    const socket = await rawSocket(host);
    expect(await socket.call("setPluginSecret", { plugin: "slow", name: "api_key", value: TOKEN })).toEqual({ ok: true, value: null });

    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "chat" }, "go");
    await waiting;
    expect(await socket.call("setPluginSecret", { plugin: "slow", name: "api_key", value: null })).toEqual({ ok: true, value: null });
    release();
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done");

    const entries = JSON.stringify(client.view.current().conversation!.entries);
    expect(entries).toContain("key=[redacted]");
    expect(entries).not.toContain(TOKEN);
  });
});

describe("secret store", () => {
  it("keeps names like __proto__ and constructor as plain names", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const path = join(dir.path, "secrets.json");
    const store = await openSecretStore(path);
    await store.set("p", "other", "1");
    expect(store.get("p", "constructor")).toBeUndefined();
    expect(store.get("__proto__", "x")).toBeUndefined();
    await store.set("p", "__proto__", "2");
    await store.set("__proto__", "constructor", "3");
    expect(store.get("p", "__proto__")).toBe("2");
    expect(store.get("__proto__", "constructor")).toBe("3");
    const reopened = await openSecretStore(path);
    expect(reopened.get("p", "__proto__")).toBe("2");
    expect(reopened.get("__proto__", "constructor")).toBe("3");
    expect(reopened.get("p", "other")).toBe("1");
  });
});
