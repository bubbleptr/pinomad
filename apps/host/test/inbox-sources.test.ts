// Inbox event sources (5.39, ADR-0051 §10): schedules, plugin sources and the
// LAN webhook, added through the gateway's calls and seen in the `inbox` stream.
import { once } from "node:events";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "@pinomad/protocol/frames.ts";
import type { InboxSource, InboxWebhookAccess } from "@pinomad/protocol/inbox.ts";
import type { OpenedHost } from "../src/host.ts";
import { InboxDoc, type InboxTask, TimerDoc } from "../src/inbox.ts";
import { SourceCursorsDoc, webhookPeerAllowed, webhookSignature } from "../src/inbox-sources.ts";
import { IndexDoc } from "../src/organization.ts";
import { connectTo, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const context = BACKGROUND_CONTEXT;
const defer = useCleanups();
const GITHUB_EXAMPLE = fileURLToPath(new URL("../../../examples/plugins/github", import.meta.url));
const TOKEN = "tok_feed_0123456789SECRET";

/** Calls and frames over a raw socket: the source calls have no controller methods yet. */
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
  const call = async (method: string, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
    const callId = ++id;
    socket.send(JSON.stringify({ type: "call", id: callId, method, args }));
    const frame = await next((candidate) => candidate.type === "result" && candidate.id === callId);
    if (frame.type !== "result") throw new Error("unreachable");
    return frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error };
  };
  const ok = async <T>(method: string, args: unknown): Promise<T> => {
    const result = await call(method, args);
    if (!result.ok) throw new Error(`${method} failed: ${result.error}`);
    return result.value as T;
  };
  return { call, ok, next };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A test plugin: two polled sources reading a JSON file named by the filter, and one pushed source. */
const FEED = `
import { readFile } from "node:fs/promises";
import { definePlugin } from "@pinomad/plugin/v1";
export default definePlugin((p) => {
  const token = p.secret("token", { description: "A token" });
  const poll = (key) => async ({ cursor }, ctx) => {
    const file = JSON.parse(await readFile(ctx.filter, "utf8"));
    const value = (await ctx.secret(token)) ?? "";
    if (file.fail) throw new Error(file.fail + " " + value);
    globalThis.__feedCursors = [...(globalThis.__feedCursors ?? []), cursor ?? null];
    return {
      events: (file[key] ?? []).map((event) => ({ ...event, summary: event.summary.replace("$TOKEN", value) })),
      cursor: (typeof cursor === "number" ? cursor : 0) + 1,
    };
  };
  p.source({ name: "items", description: "Items", filter: "A JSON file", poll: { run: poll("events") } });
  p.source({ name: "replies", description: "Replies", filter: "A JSON file", followedOnly: true, poll: { run: poll("replies") } });
  p.source({
    name: "pushed",
    description: "Pushed items",
    listen: (emit) => {
      globalThis.__feedEmit = emit;
      return () => { globalThis.__feedEmit = undefined; };
    },
  });
  // Reads the token, then waits for the test before using it.
  p.source({
    name: "slow",
    description: "Slow",
    poll: {
      run: async (_input, ctx) => {
        const value = (await ctx.secret(token)) ?? "";
        await new Promise((resolve) => { globalThis.__feedGate = resolve; });
        return { events: [{ id: "s1", summary: "saw " + value }] };
      },
    },
  });
  p.source({
    name: "broken",
    description: "Broken",
    listen: async (_emit, ctx) => {
      throw new Error("connect failed with " + (await ctx.secret(token)));
    },
  });
});
`;

type Feed = typeof globalThis & { __feedEmit?: (event: unknown) => Promise<void>; __feedCursors?: unknown[]; __feedGate?: () => void };
afterEach(() => {
  delete (globalThis as Feed).__feedGate;
  delete (globalThis as Feed).__feedEmit;
  delete (globalThis as Feed).__feedCursors;
});

async function sourcesHost(options: { sandbox?: boolean; remote?: boolean; plugins?: Record<string, string>; copy?: Record<string, string> } = {}) {
  const project = await tempDir();
  defer(project.remove);
  const dataDir = await tempDir();
  defer(dataDir.remove);
  for (const [name, server] of Object.entries(options.plugins ?? {})) {
    const dir = join(dataDir.path, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
    await writeFile(join(dir, "server.ts"), server);
  }
  for (const [name, from] of Object.entries(options.copy ?? {})) await cp(from, join(dataDir.path, "plugins", name), { recursive: true });
  const host = await startFauxHost(defer, {
    dataDir: dataDir.path,
    projects: [project.path],
    answers: Array.from({ length: 30 }, () => "ok"),
    inboxSandbox: async () => options.sandbox ?? true,
    ...(options.remote === true ? { remote: { port: 0 } } : {}),
  });
  const key = (await host.harness.snapshot(IndexDoc, context))!.projects[0]!.path;
  const socket = await rawSocket(host);
  const tasks = async (): Promise<InboxTask[]> => (await host.harness.snapshot(InboxDoc, context))?.inboxes[key]?.tasks ?? [];
  return { host, key, socket, tasks, dataDir: dataDir.path, project: project.path };
}

describe("webhookPeerAllowed", () => {
  it("takes this machine, private LANs and the tailnet, and nothing public", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.255.1", "100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1", "::ffff:192.168.0.9"]) {
      expect(webhookPeerAllowed(address), address).toBe(true);
    }
    for (const address of [undefined, "8.8.8.8", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.254.1.1", "2001:4860:4860::8888", "fe80::1", "::ffff:8.8.8.8", "not an ip"]) {
      expect(webhookPeerAllowed(address), String(address)).toBe(false);
    }
  });
});

/** POST one event to a webhook, signed unless the test says otherwise. */
async function post(
  access: InboxWebhookAccess,
  body: string,
  options: { url?: string; secret?: string; timestamp?: string; headers?: Record<string, string>; source?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const response = await fetch(options.url ?? access.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pinomad-source": options.source ?? access.source,
      "x-pinomad-timestamp": timestamp,
      "x-pinomad-signature": webhookSignature(options.secret ?? access.secret, timestamp, body),
      ...options.headers,
    },
    body,
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("webhook sources", () => {
  it("take signed events, route them by thread, and refuse bad signatures, replays, stale times and big bodies", async () => {
    const { key, socket, tasks } = await sourcesHost();
    const added = await socket.ok<{ sourceId: string; webhook: InboxWebhookAccess }>("addInboxSource", {
      project: key,
      name: "Alerts",
      trusted: false,
      spec: { kind: "webhook" },
    });
    const access = added.webhook;
    expect(access.source).toBe(added.sourceId);
    expect(access.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/inbox\/[^/]+\/events$/);

    const first = JSON.stringify({ id: "a1", summary: "Disk almost full on nas", thread: "alerts:nas" });
    expect(await post(access, first)).toEqual({ status: 200, body: { accepted: true, duplicate: false } });
    const [task] = await until(tasks, (list) => list.length === 1);
    expect(task!.events[0]).toMatchObject({ id: `webhook:${added.sourceId}:a1`, source: "webhook", thread: "alerts:nas", trusted: false });

    // The same request again (a replay inside the window, or a sender's retry) changes nothing.
    expect(await post(access, first)).toEqual({ status: 200, body: { accepted: true, duplicate: true } });
    // A later event on the thread goes to the same task.
    expect((await post(access, JSON.stringify({ id: "a2", summary: "Disk full", thread: "alerts:nas" }))).status).toBe(200);
    const routed = await until(tasks, (list) => list[0]!.events.length === 2);
    expect(routed).toHaveLength(1);

    const later = JSON.stringify({ id: "a3", summary: "x" });
    const refused = { status: 401, body: { error: "Unknown source, bad signature or stale timestamp" } };
    expect(await post(access, later, { secret: "not the secret" })).toEqual(refused);
    expect(await post(access, later, { timestamp: String(Math.floor(Date.now() / 1000) - 600) })).toEqual(refused);
    expect(await post(access, later, { source: "no-such-source" })).toEqual(refused);
    expect((await post(access, later, { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(403);
    expect((await post(access, JSON.stringify({ id: "big", summary: "x".repeat(70_000) }))).status).toBe(413);
    expect((await post(access, JSON.stringify({ id: "", summary: "x" }))).status).toBe(400);
    // Signed for one project's path, sent to another's.
    expect(await post(access, later, { url: access.url.replace(/\/inbox\/[^/]+\//, "/inbox/other-0123456789/") })).toEqual(refused);

    // A reset secret replaces the old one at once.
    const reset = await socket.ok<InboxWebhookAccess>("resetInboxWebhookSecret", { sourceId: added.sourceId });
    expect(reset.secret).not.toBe(access.secret);
    expect(await post(access, later)).toEqual(refused);
    expect((await post(reset, later)).status).toBe(200);

    // Off: refused like an unknown source; removed: the secret is gone too.
    await socket.ok("setInboxSourceEnabled", { sourceId: added.sourceId, enabled: false });
    expect(await post(reset, JSON.stringify({ id: "a4", summary: "x" }))).toEqual(refused);
    await socket.ok("removeInboxSource", { sourceId: added.sourceId });
    await socket.ok("setInboxSourceEnabled", { sourceId: added.sourceId, enabled: true }).then(
      () => expect.unreachable(),
      (error: Error) => expect(error.message).toMatch(/No source/),
    );
    expect((await tasks()).flatMap((each) => each.events).map((event) => event.id)).not.toContain(`webhook:${added.sourceId}:a4`);
  });

  it("is served on the LAN listener too, and the URL names it", async () => {
    const { key, socket, host, tasks } = await sourcesHost({ remote: true });
    const { webhook } = await socket.ok<{ webhook: InboxWebhookAccess }>("addInboxSource", { project: key, name: "LAN", trusted: true, spec: { kind: "webhook" } });
    const remotePort = new URL(host.remote!.url).port;
    expect(new URL(webhook.url).port).toBe(remotePort);
    // Whatever LAN address the URL names, this machine reaches the listener on loopback.
    const local = new URL(webhook.url);
    local.hostname = "127.0.0.1";
    expect((await post(webhook, JSON.stringify({ id: "l1", summary: "from the LAN" }), { url: local.toString() })).status).toBe(200);
    const [task] = await until(tasks, (list) => list.length === 1);
    expect(task!.events[0]).toMatchObject({ trusted: true, source: "webhook" });
  });
});

describe("without a sandbox", () => {
  it("refuses plugin and webhook sources but takes schedules", async () => {
    const { key, socket, host } = await sourcesHost({ sandbox: false, plugins: { feed: FEED } });
    const hello = await socket.next((frame) => frame.type === "hello");
    expect(hello.type === "hello" && hello.plugins?.find((plugin) => plugin.name === "feed")?.sources).toEqual([
      { name: "items", description: "Items", filter: "A JSON file" },
      { name: "replies", description: "Replies", filter: "A JSON file", followedOnly: true },
      { name: "pushed", description: "Pushed items" },
      { name: "slow", description: "Slow" },
      { name: "broken", description: "Broken" },
    ]);
    const client = await connectTo(defer, host);
    await waitForView(client.view, (view) => view.inbox !== null);
    expect(client.view.current().inbox?.externalSources).toBe(false);
    for (const spec of [{ kind: "webhook" }, { kind: "plugin", plugin: "feed", source: "items", filter: "/x" }]) {
      const result = await socket.call("addInboxSource", { project: key, name: "x", trusted: false, spec });
      expect(result.ok === false && result.error).toMatch(/no sandbox/);
    }
    const schedule = await socket.call("addInboxSource", {
      project: key,
      name: "Daily check",
      trusted: true,
      spec: { kind: "schedule", note: "Check dependencies", schedule: { kind: "daily", time: "08:00", timeZone: "UTC" } },
    });
    expect(schedule.ok).toBe(true);
  });
});

describe("plugin sources", () => {
  it("poll into the right task by thread, scrub secrets, drop unfollowed replies and show problems", async () => {
    const { key, socket, tasks, host, dataDir } = await sourcesHost({ plugins: { feed: FEED } });
    await socket.ok("setPluginSecret", { plugin: "feed", name: "token", value: TOKEN });
    const file = join(dataDir, "feed.json");
    await writeFile(
      file,
      JSON.stringify({
        events: [
          { id: "1", thread: "feed:1", summary: "first $TOKEN", title: "Item one" },
          { id: "2", thread: "feed:1", summary: "second" },
          { id: "3", thread: "feed:2", summary: "other" },
        ],
        replies: [
          { id: "r1", thread: "feed:1", summary: "a reply" },
          { id: "r2", thread: "feed:9", summary: "a stray reply" },
        ],
      }),
    );
    const { sourceId } = await socket.ok<{ sourceId: string }>("addInboxSource", {
      project: key,
      name: "Feed",
      trusted: false,
      spec: { kind: "plugin", plugin: "feed", source: "items", filter: file },
    });
    const list = await until(tasks, (each) => each.length === 2);
    const one = list.find((task) => task.title === "Item one")!;
    expect(one.events.map((event) => [event.id, event.source, event.trusted, event.summary])).toEqual([
      [`plugin:feed:${sourceId}:1`, "plugin:feed", false, "first [redacted]"],
      [`plugin:feed:${sourceId}:2`, "plugin:feed", false, "second"],
    ]);
    expect((await host.harness.snapshot(SourceCursorsDoc, context))?.cursors[sourceId]).toBe(1);

    // Followed only: the reply on feed:1 joins its task; the one on an unknown thread is dropped.
    await socket.ok("addInboxSource", { project: key, name: "Replies", trusted: false, spec: { kind: "plugin", plugin: "feed", source: "replies", filter: file } });
    const replied = await until(tasks, (each) => each.find((task) => task.id === one.id)!.events.length === 3);
    expect(replied).toHaveLength(2);
    expect(replied.flatMap((task) => task.events).some((event) => event.summary === "a stray reply")).toBe(false);

    // A failing poll shows on the source, scrubbed; turning it off and on polls again from the stored cursor.
    await writeFile(file, JSON.stringify({ fail: "boom" }));
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: false });
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: true });
    const problem = await until(
      async () => (await sourceList(host, key)).find((source) => source.id === sourceId)?.problem,
      (value) => value !== undefined,
    );
    expect(problem).toBe("boom [redacted]");
    await writeFile(file, JSON.stringify({ events: [] }));
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: false });
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: true });
    await until(async () => (await sourceList(host, key)).find((source) => source.id === sourceId), (source) => source !== undefined && source.problem === undefined);
    expect((globalThis as Feed).__feedCursors).toContain(1);
  });

  it("take pushed events while enabled, and stop listening when turned off", async () => {
    const { key, socket, tasks, host } = await sourcesHost({ plugins: { feed: FEED } });
    const { sourceId } = await socket.ok<{ sourceId: string }>("addInboxSource", { project: key, name: "Pushed", trusted: true, spec: { kind: "plugin", plugin: "feed", source: "pushed", filter: "" } });
    const emit = await until(async () => (globalThis as Feed).__feedEmit, (value) => value !== undefined);
    // A malformed event, unawaited as from a socket handler: it shows on the source and rejects nothing.
    void emit!({ id: "", summary: "no id" });
    const problem = await until(
      async () => (await sourceList(host, key)).find((source) => source.id === sourceId)?.problem,
      (value) => value !== undefined,
    );
    expect(problem).toMatch(/id is not a non-empty string/);
    await emit!({ id: "p1", summary: "pushed one", thread: "push:1" });
    // Delivering again clears the problem.
    await until(async () => (await sourceList(host, key)).find((source) => source.id === sourceId), (source) => source?.problem === undefined);
    const [task] = await until(tasks, (list) => list.length === 1);
    expect(task!.events[0]).toMatchObject({ id: `plugin:feed:${sourceId}:p1`, trusted: true, thread: "push:1" });
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: false });
    await until(async () => (globalThis as Feed).__feedEmit, (value) => value === undefined);
  });

  it("scrub a secret the source read even after the user cleared it, and a listener's start error", async () => {
    const { key, socket, tasks, host } = await sourcesHost({ plugins: { feed: FEED } });
    await socket.ok("setPluginSecret", { plugin: "feed", name: "token", value: TOKEN });
    await socket.ok("addInboxSource", { project: key, name: "Slow", trusted: false, spec: { kind: "plugin", plugin: "feed", source: "slow", filter: "" } });
    const release = await until(async () => (globalThis as Feed).__feedGate, (value) => value !== undefined);
    // Cleared while the poll holds the old value.
    await socket.ok("setPluginSecret", { plugin: "feed", name: "token", value: null });
    release!();
    const [task] = await until(tasks, (list) => list.length === 1);
    expect(task!.events[0]!.summary).toBe("saw [redacted]");

    await socket.ok("setPluginSecret", { plugin: "feed", name: "token", value: TOKEN });
    const { sourceId } = await socket.ok<{ sourceId: string }>("addInboxSource", { project: key, name: "Broken", trusted: false, spec: { kind: "plugin", plugin: "feed", source: "broken", filter: "" } });
    const problem = await until(
      async () => (await sourceList(host, key)).find((source) => source.id === sourceId)?.problem,
      (value) => value !== undefined,
    );
    expect(problem).toBe("connect failed with [redacted]");
  });

  it("the GitHub example's PR comment and CI sources reach only the task that follows the PR", async () => {
    const later = "2099-01-01T00:00:00Z";
    const replies: Record<string, unknown> = { "/repos/acme/web/issues/comments": [], "/repos/acme/web/pulls/comments": [], "/repos/acme/web/actions/runs": { workflow_runs: [] } };
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replies[path] ?? []));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    defer(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const before = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    defer(() => {
      if (before === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = before;
    });

    const { key, socket, tasks, host } = await sourcesHost({ copy: { github: GITHUB_EXAMPLE } });
    await socket.ok("setPluginSecret", { plugin: "github", name: "github_token", value: TOKEN });
    // The task that opened PR #7 follows its thread.
    const { addInboxEvent } = await import("../src/inbox.ts");
    const { task: followed } = await addInboxEvent(host.harness, key, { id: "pr7", source: "user", thread: "github:acme/web#7", summary: "Fix login", trusted: true }, context);
    const add = async (source: string) =>
      (await socket.ok<{ sourceId: string }>("addInboxSource", { project: key, name: source, trusted: false, spec: { kind: "plugin", plugin: "github", source, filter: "acme/web" } })).sourceId;
    const ids = [await add("pr-comments"), await add("ci")];
    for (const id of ids) await until(async () => (await host.harness.snapshot(SourceCursorsDoc, context))?.cursors[id], (cursor) => cursor !== undefined);

    replies["/repos/acme/web/issues/comments"] = [
      { id: 11, html_url: "https://github.example/acme/web/pull/7#issuecomment-11", created_at: later, user: { login: "ana" }, issue_url: "https://api.example/repos/acme/web/issues/7" },
      { id: 12, html_url: "https://github.example/acme/web/issues/9#issuecomment-12", created_at: later, issue_url: "https://api.example/repos/acme/web/issues/9" },
      { id: 13, html_url: "https://github.example/acme/web/pull/8#issuecomment-13", created_at: later, issue_url: "https://api.example/repos/acme/web/issues/8" },
    ];
    replies["/repos/acme/web/pulls/comments"] = [
      { id: 14, html_url: "https://github.example/acme/web/pull/7#discussion_r14", created_at: later, user: { login: "bo" }, pull_request_url: "https://api.example/repos/acme/web/pulls/7" },
    ];
    replies["/repos/acme/web/actions/runs"] = {
      workflow_runs: [{ id: 99, run_attempt: 1, name: "ci", conclusion: "failure", html_url: "https://github.example/acme/web/actions/runs/99", updated_at: later, pull_requests: [{ number: 7 }] }],
    };
    for (const sourceId of ids) {
      await socket.ok("setInboxSourceEnabled", { sourceId, enabled: false });
      await socket.ok("setInboxSourceEnabled", { sourceId, enabled: true });
    }
    const list = await until(tasks, (each) => each.find((task) => task.id === followed)!.events.length === 4);
    const events = list.find((task) => task.id === followed)!.events.slice(1);
    expect(events.map((event) => event.id).sort()).toEqual([`plugin:github:${ids[0]}:comment:11`, `plugin:github:${ids[0]}:comment:14`, `plugin:github:${ids[1]}:run:99:1:7`].sort());
    expect(events.every((event) => event.thread === "github:acme/web#7" && !event.trusted)).toBe(true);
    // The issue comment and the comment on an unfollowed PR opened nothing.
    expect(list).toHaveLength(1);
  });

  it("the GitHub example's issues source starts after the backlog and brings new issues labelled as filtered", async () => {
    const issues = [{ number: 1, title: "Old bug", html_url: "https://github.example/acme/web/issues/1", labels: [{ name: "bug" }] }];
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.url} ${request.headers.authorization}`);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issues));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    defer(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const before = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    defer(() => {
      if (before === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = before;
    });

    const { key, socket, tasks, host } = await sourcesHost({ copy: { github: GITHUB_EXAMPLE } });
    await socket.ok("setPluginSecret", { plugin: "github", name: "github_token", value: TOKEN });
    const { sourceId } = await socket.ok<{ sourceId: string }>("addInboxSource", {
      project: key,
      name: "Bugs",
      trusted: false,
      spec: { kind: "plugin", plugin: "github", source: "issues", filter: "acme/web label:bug" },
    });
    await until(async () => (await host.harness.snapshot(SourceCursorsDoc, context))?.cursors[sourceId], (cursor) => cursor !== undefined);
    expect(requests[0]).toBe(`/repos/acme/web/issues?state=open&sort=created&direction=desc&per_page=100&labels=bug Bearer ${TOKEN}`);
    expect(await tasks()).toEqual([]);

    issues.unshift({ number: 2, title: "New bug", html_url: "https://github.example/acme/web/issues/2", labels: [{ name: "bug" }] });
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: false });
    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: true });
    const [task] = await until(tasks, (list) => list.length === 1);
    expect(task).toMatchObject({ title: "#2 New bug" });
    expect(task!.events[0]).toMatchObject({ thread: "github:acme/web#2", trusted: false, source: "plugin:github" });
    expect(task!.events[0]!.summary).toContain("https://github.example/acme/web/issues/2");
  });
});

/** The sources the `inbox` stream would show for `key`, built from the documents as the stream does. */
async function sourceList(host: OpenedHost, key: string): Promise<InboxSource[]> {
  const { hostInbox } = await import("../src/inbox-view.ts");
  const { SourcesDoc } = await import("../src/inbox-sources.ts");
  const [index, inboxes, timers, sources] = await Promise.all([
    host.harness.snapshot(IndexDoc, context),
    host.harness.snapshot(InboxDoc, context),
    host.harness.snapshot(TimerDoc, context),
    host.harness.snapshot(SourcesDoc, context),
  ]);
  const value = hostInbox(index ?? null, inboxes?.inboxes ?? {}, timers?.timers ?? [], new Map(), sources?.sources ?? [], true);
  return [...(value.inboxes.find((inbox) => inbox.project === key)?.sources ?? [])];
}

describe("schedule sources", () => {
  it("fire as a new task named after the source, then move to their next time; off stops them", async () => {
    const { key, socket, tasks, host } = await sourcesHost();
    const { sourceId } = await socket.ok<{ sourceId: string }>("addInboxSource", {
      project: key,
      name: "New year check",
      trusted: true,
      spec: { kind: "schedule", note: "Look over the dependencies", schedule: { kind: "cron", expression: "0 0 1 1 *", timeZone: "UTC" } },
    });
    const nextYear = Date.UTC(new Date().getUTCFullYear() + 1, 0, 1);
    const [source] = await sourceList(host, key);
    expect(source).toMatchObject({ id: sourceId, name: "New year check", enabled: true, trusted: true, next: nextYear });
    // Not a follow-up: cancelFollowUp leaves it to the source's own calls.
    const cancel = await socket.call("cancelFollowUp", { timerId: `source:${sourceId}` });
    expect(cancel.ok === false && cancel.error).toMatch(/turn the source off/);

    // Due now, as if the host had slept through it.
    await host.harness.commit(async (tx) => {
      const timer = (await tx.doc(TimerDoc)).timers.find((each) => each.source === sourceId)!;
      timer.due = Date.now() - 1_000;
    }, context);
    const [task] = await until(tasks, (list) => list.length === 1);
    expect(task).toMatchObject({ title: "New year check" });
    expect(task!.events[0]).toMatchObject({ source: "schedule", summary: "Look over the dependencies", trusted: true });
    expect((await sourceList(host, key))[0]!.next).toBe(nextYear);

    await socket.ok("setInboxSourceEnabled", { sourceId, enabled: false });
    expect((await sourceList(host, key))[0]).not.toHaveProperty("next");
    const timer = (await host.harness.snapshot(TimerDoc, context))!.timers.find((each) => each.source === sourceId)!;
    expect(timer.done).toBe(true);

    const bad = await socket.call("addInboxSource", {
      project: key,
      name: "Bad",
      trusted: true,
      spec: { kind: "schedule", note: "x", schedule: { kind: "daily", time: "25:00", timeZone: "UTC" } },
    });
    expect(bad.ok === false && bad.error).toMatch(/HH:MM/);
  });
});
