// `listFiles` (issue #138): file candidates for the composer's `@./path`
// completion — the three scopes, worktree-vs-live enumeration, the bounds,
// the match order, and the per-root cache/merge the keystroke burst rides on.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { AgentState } from "@earendil-works/pi-durable";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { FileListing } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { createCandidateLister, listFiles, matchFiles, type FileCandidates, type RootMode } from "../src/files.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startConversation, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
let nextCall = 1;

async function socketTo(host: OpenedHost) {
  const socket = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
  defer(() => socket.terminate());
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  return { socket, frames };
}

function call<M extends keyof CallMethods>(
  client: { socket: WebSocket; frames: ServerFrame[] },
  method: M,
  args: CallMethods[M]["args"],
): Promise<Extract<ServerFrame, { type: "result" }>> {
  const id = nextCall++;
  client.socket.send(JSON.stringify({ type: "call", id, method, args }));
  return (async () => {
    for (;;) {
      const found = client.frames.find(
        (frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result" && frame.id === id,
      );
      if (found !== undefined) return found;
      await once(client.socket, "message");
    }
  })();
}

const filesOf = (result: Extract<ServerFrame, { type: "result" }>): FileListing =>
  (result as { value: FileListing }).value;

/** A promise plus its resolver — `Promise.withResolvers` is not in this lib target. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A repo with a tracked file, an ignored rule, and a committed file in `sub/`. */
async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["-C", path, "init", "-b", "main"]);
  await writeFile(join(path, "tracked.txt"), "tracked\n");
  await writeFile(join(path, ".gitignore"), "*.log\n");
  await mkdir(join(path, "sub"));
  await writeFile(join(path, "sub", "inner.txt"), "inner\n");
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
}

/** Resolve once the shown conversation's first run finished — the worktree is materialized by then. */
const settled = (client: RemoteDurable) =>
  waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).length >= 2);

describe("listFiles", () => {
  it("lists a project directory's live files for checkout project; the committed tree for worktree", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await initRepo(dir.path);
    // A commit history detail: untracked/ignored/deleted only live in the worktree.
    await writeFile(join(dir.path, "untracked.txt"), "new\n");
    await writeFile(join(dir.path, "debug.log"), "ignored\n");
    await rm(join(dir.path, "sub", "inner.txt"));

    const host = await startFauxHost(defer, { projects: [dir.path] });
    const raw = await socketTo(host);

    const project = filesOf(await call(raw, "listFiles", { scope: { kind: "project", path: dir.path, checkout: "project" }, query: "" }));
    expect(project.truncated).toBe(false);
    expect(project.files).toContain("tracked.txt");
    expect(project.files).toContain("untracked.txt");
    expect(project.files).not.toContain("debug.log"); // .gitignore
    expect(project.files).not.toContain("sub/inner.txt"); // deleted in the working tree

    // A worktree checkout starts from HEAD — untracked and deleted never show.
    const worktree = filesOf(await call(raw, "listFiles", { scope: { kind: "project", path: dir.path, checkout: "worktree" }, query: "" }));
    expect(worktree.files).toContain("tracked.txt");
    expect(worktree.files).toContain("sub/inner.txt");
    expect(worktree.files).not.toContain("untracked.txt");
    expect(worktree.files).not.toContain("debug.log");
  });

  it("scopes a project subdirectory to its own files, in both checkout modes", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await initRepo(dir.path);
    const host = await startFauxHost(defer, { projects: [join(dir.path, "sub")] });
    const raw = await socketTo(host);

    const live = filesOf(await call(raw, "listFiles", { scope: { kind: "project", path: join(dir.path, "sub"), checkout: "project" }, query: "" }));
    expect(live.files).toEqual(["inner.txt"]);
    const head = filesOf(await call(raw, "listFiles", { scope: { kind: "project", path: join(dir.path, "sub"), checkout: "worktree" }, query: "" }));
    expect(head.files).toEqual(["inner.txt"]);
  });

  it("lists a conversation's checkout files — untracked included, deleted and ignored out", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await initRepo(dir.path);
    const host = await startFauxHost(defer, { projects: [dir.path] });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const id = await startConversation(client, { kind: "project", path: dir.path }, "work");
    await settled(client);
    const cwd = (await host.harness.snapshot(AgentDoc, id, context))!.cwd!;
    // The worktree checkout: add an untracked file, drop a tracked one.
    await writeFile(join(cwd, "fresh.md"), "fresh\n");
    await rm(join(cwd, "tracked.txt"));

    const result = filesOf(await call(raw, "listFiles", { scope: { kind: "conversation", conversationId: id }, query: "" }));
    expect(result.files).toContain("fresh.md");
    expect(result.files).toContain("sub/inner.txt");
    expect(result.files).not.toContain("tracked.txt");
  });

  it("answers an empty list for a Chat conversation", async () => {
    const host = await startFauxHost(defer);
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);
    const id = await startChat(client, "hi");
    await settled(client);
    const result = await call(raw, "listFiles", { scope: { kind: "conversation", conversationId: id }, query: "" });
    expect(result).toMatchObject({ ok: true, value: { files: [], truncated: false } });
  });

  it("fails a conversation whose checkout is gone — never materializes a worktree", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await initRepo(dir.path);
    const host = await startFauxHost(defer, { projects: [dir.path] });
    const client = await connectTo(defer, host);
    const raw = await socketTo(host);

    const id = await startConversation(client, { kind: "project", path: dir.path }, "work");
    await settled(client);
    const cwd = (await host.harness.snapshot(AgentDoc, id, context))!.cwd!;
    await rm(cwd, { recursive: true, force: true });

    const result = await call(raw, "listFiles", { scope: { kind: "conversation", conversationId: id }, query: "" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("checkout") });
    // No ensureWorktree ran: the directory stays gone.
    await expect(run("git", ["-C", cwd, "rev-parse"])).rejects.toThrow();
  });

  it("rejects unknown conversations and unregistered projects", async () => {
    const host = await startFauxHost(defer);
    const raw = await socketTo(host);
    const missing = await call(raw, "listFiles", { scope: { kind: "conversation", conversationId: 999 as ConversationId }, query: "" });
    expect(missing).toMatchObject({ ok: false, error: "Conversation 999 does not exist" });
    const outside = await tempDir();
    defer(outside.remove);
    const unknown = await call(raw, "listFiles", { scope: { kind: "project", path: outside.path, checkout: "project" }, query: "" });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Unknown project") });
  });

  it("drops submodule gitlinks in both checkout modes", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await initRepo(dir.path);
    // A gitlink entry without a real submodule checkout — the index line is enough.
    const head = (await run("git", ["-C", dir.path, "rev-parse", "HEAD"])).stdout.trim();
    await run("git", ["-C", dir.path, "update-index", "--add", "--cacheinfo", `160000,${head},vendored`]);
    await run("git", ["-C", dir.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "gitlink"]);

    const host = await startFauxHost(defer, { projects: [dir.path] });
    const raw = await socketTo(host);
    for (const checkout of ["project", "worktree"] as const) {
      const result = filesOf(await call(raw, "listFiles", { scope: { kind: "project", path: dir.path, checkout }, query: "" }));
      expect(result.files).not.toContain("vendored");
      expect(result.files).not.toContain("vendored/");
    }
  });

  it("walks a non-git directory without following directory symlinks", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "src"));
    await writeFile(join(dir.path, "src", "a.ts"), "a");
    await writeFile(join(dir.path, "root.txt"), "r");
    await mkdir(join(dir.path, ".hidden"));
    await writeFile(join(dir.path, ".hidden", "h.ts"), "h");
    await mkdir(join(dir.path, "node_modules"));
    await writeFile(join(dir.path, "node_modules", "dep.js"), "d");
    // A directory symlink: listed as an entry, never descended into.
    const outside = await tempDir();
    defer(outside.remove);
    await writeFile(join(outside.path, "secret.ts"), "s");
    await symlink(outside.path, join(dir.path, "link-dir"), "dir");

    const host = await startFauxHost(defer, { projects: [dir.path] });
    const raw = await socketTo(host);
    const result = filesOf(await call(raw, "listFiles", { scope: { kind: "project", path: dir.path, checkout: "project" }, query: "" }));
    expect(result.files).toContain("src/a.ts");
    expect(result.files).toContain("root.txt");
    expect(result.files).toContain("link-dir");
    expect(result.files).not.toContain(".hidden/h.ts");
    expect(result.files).not.toContain("node_modules/dep.js");
    expect(result.files).not.toContain("link-dir/secret.ts");
  });

  it("excludes whitespace/backtick/control paths and answers the staged match order", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "src"), { recursive: true });
    await writeFile(join(dir.path, "src", "main.ts"), "x");
    await writeFile(join(dir.path, "src", "main-extra.ts"), "x");
    await writeFile(join(dir.path, "domain-main.txt"), "x");
    await writeFile(join(dir.path, "with space.txt"), "x");
    await writeFile(join(dir.path, "tick`tock.txt"), "x");
    await writeFile(join(dir.path, "ctl\tname.txt"), "x");

    const host = await startFauxHost(defer, { projects: [dir.path] });
    const raw = await socketTo(host);
    const scope = { kind: "project" as const, path: dir.path, checkout: "project" as const };

    const empty = filesOf(await call(raw, "listFiles", { scope, query: "" }));
    expect(empty.files).toContain("domain-main.txt");
    expect(empty.files).not.toContain("with space.txt");
    expect(empty.files).not.toContain("tick`tock.txt");
    expect(empty.files).not.toContain("ctl\tname.txt");

    // Filename prefix beats filename-contains beats path-contains; shorter first within a tier.
    const matched = filesOf(await call(raw, "listFiles", { scope, query: "main" }));
    expect(matched.files).toEqual(["src/main.ts", "src/main-extra.ts", "domain-main.txt"]);
  });

  it("closes a socket on malformed args (4400) instead of a result", async () => {
    const host = await startFauxHost(defer);
    const raw = await socketTo(host);
    raw.socket.send(JSON.stringify({ type: "call", id: nextCall++, method: "listFiles", args: { scope: { kind: "nope" }, query: "" } }));
    await new Promise<void>((resolve) => raw.socket.once("close", (code) => {
      expect(code).toBe(4400);
      resolve();
    }));
    expect(raw.frames.some((f) => f.type === "result")).toBe(false);
  });

  it("marks early-stop enumerations truncated even at zero hits", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, { projects: [dir.path] });
    const enumerate = () => Promise.resolve({ files: [] as string[], truncated: true });
    const listing = await listFiles(
      host.harness,
      dir.path,
      enumerate,
      { kind: "project", path: dir.path, checkout: "project" },
      "zzz",
      context,
    );
    expect(listing).toEqual({ files: [], truncated: true });
  });
});

describe("matchFiles", () => {
  it("tiers prefix > basename-contains > path-contains, shorter paths first", () => {
    const candidates = ["src/app-main.ts", "main.ts", "a/b/mains.txt", "domain.main"];
    expect(matchFiles(candidates, "main").files).toEqual(["main.ts", "a/b/mains.txt", "domain.main", "src/app-main.ts"]);
    // Case-insensitive.
    expect(matchFiles(["SRC/MAIN.TS"], "main").files).toEqual(["SRC/MAIN.TS"]);
    // Empty query: plain path order.
    expect(matchFiles(["b.ts", "a/x.ts", "a.ts"], "").files).toEqual(["a.ts", "a/x.ts", "b.ts"]);
  });

  it("caps at 50 and reports the cut", () => {
    const many = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    const result = matchFiles(many, "");
    expect(result.files).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.files[0]).toBe("f000.ts");
  });
});

describe("createCandidateLister", () => {
  const manual = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("merges concurrent scans of the same root and caches them briefly", async () => {
    const scans: string[] = [];
    const clock = manual();
    const gate = deferred<FileCandidates>();
    const enumerate = async (root: string, _mode: RootMode): Promise<FileCandidates> => {
      scans.push(root);
      return await gate.promise;
    };
    const list = createCandidateLister(enumerate, { now: clock.now, ttlMs: 3000 });

    const a = list("/root", "live");
    const b = list("/root", "live");
    await Promise.resolve();
    expect(scans).toEqual(["/root"]); // one scan for both callers
    gate.resolve({ files: ["x.ts"], truncated: false });
    expect(await a).toEqual({ files: ["x.ts"], truncated: false });
    expect(await b).toEqual({ files: ["x.ts"], truncated: false });

    // Within the TTL the cache answers — no second scan.
    expect(await list("/root", "live")).toEqual({ files: ["x.ts"], truncated: false });
    expect(scans).toEqual(["/root"]);
    clock.advance(3100);
    const second = deferred<FileCandidates>();
    const enumerate2 = async (): Promise<FileCandidates> => {
      scans.push("again");
      return await second.promise;
    };
    const list2 = createCandidateLister(enumerate2, { now: clock.now, ttlMs: 3000 });
    const pending = list2("/root", "live");
    await Promise.resolve();
    expect(scans).toEqual(["/root", "again"]);
    second.resolve({ files: [], truncated: false });
    await pending;
  });

  it("bounds concurrent scans; queued scans start as slots free", async () => {
    const clock = manual();
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const enumerate = (root: string, _mode: RootMode): Promise<FileCandidates> => {
      order.push(`start:${root}`);
      return new Promise((resolve) => releases.push(() => {
        order.push(`end:${root}`);
        resolve({ files: [], truncated: false });
      }));
    };
    const list = createCandidateLister(enumerate, { now: clock.now, maxConcurrent: 1 });
    const a = list("/a", "live");
    const b = list("/b", "live");
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    await tick();
    expect(order).toEqual(["start:/a"]);
    // Freeing /a's slot lets the queued /b scan start — deterministically.
    releases.shift()!();
    await tick();
    expect(order).toEqual(["start:/a", "end:/a", "start:/b"]);
    releases.shift()!();
    await Promise.all([a, b]);
    expect(order).toEqual(["start:/a", "end:/a", "start:/b", "end:/b"]);
  });

  it("does not cache a failed scan", async () => {
    const clock = manual();
    let n = 0;
    const enumerate = (): Promise<FileCandidates> => {
      n += 1;
      return n === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ files: [], truncated: false });
    };
    const list = createCandidateLister(enumerate, { now: clock.now });
    await expect(list("/r", "live")).rejects.toThrow("boom");
    expect(await list("/r", "live")).toEqual({ files: [], truncated: false });
    expect(n).toBe(2);
  });
});
