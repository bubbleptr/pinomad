// ADR-0010 behaviors: per-conversation worktrees, fork snapshots, lazy
// creation, archive cleanup — exercised end to end with real git in temp dirs.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { AgentState, ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { coding } from "../src/extensions/coding.ts";
import { createContext } from "../src/extensions/context.ts";
import { checkoutInfo, IndexDoc } from "../src/organization.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const run = promisify(execFile);
const git = (dir: string, args: readonly string[]) => run("git", ["-C", dir, ...args]).then(({ stdout }) => stdout.trim());
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A repo at `path` with two tracked files and an ignore rule. */
async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["-C", path, "init", "-b", "main"]);
  await writeFile(join(path, "tracked.txt"), "tracked\n");
  await writeFile(join(path, "doomed.txt"), "to be deleted\n");
  await writeFile(join(path, ".gitignore"), "*.log\n");
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
}

/** A repo with an extra commit inside `sub/`, so a subdir project has files to check out. */
async function initRepoWithSub(path: string): Promise<void> {
  await initRepo(path);
  await mkdir(join(path, "sub"), { recursive: true });
  await writeFile(join(path, "sub", "inner.txt"), "inner\n");
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sub"]);
}

/** The shown conversation's agent cwd. */
function cwdOf(client: RemoteDurable): string {
  return (client.view.current().conversation!.docs["pi.agent"] as AgentState).cwd!;
}

const dataDirOf = (client: RemoteDurable): string => client.view.current().session.directory;

/** Wait until the shown conversation settles on `last` as its final text. */
const settled = (client: RemoteDurable, last: string) =>
  waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === last);

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

/** Poll a filesystem condition — git operations complete outside the view's frame stream. */
async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Records the effective system prompt of every request, in order. */
function capturePrompts(prompts: string[]): FauxResponseFactory {
  return (context) => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage(`captured-${prompts.length}`);
  };
}

describe("worktree checkouts", () => {
  it("gives each git-project conversation its own worktree and branch", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const head = await git(repoDir, ["rev-parse", "HEAD"]);
    const dataDir = await tempDir();
    defer(dataDir.remove);

    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [coding],
      answers: [
        fauxAssistantMessage(fauxToolCall("write", { path: "a-only.txt", content: "from A" }), { stopReason: "toolUse" }),
        "a done",
        "b done",
      ],
    });
    const client = await connectTo(defer, host);

    const a = await startConversation(client, { kind: "project", path: repoDir }, "a");
    await settled(client, "a done");
    const aCwd = cwdOf(client);
    expect(aCwd).toBe(join(dataDir.path, "worktrees", String(a)));
    expect(await readFile(join(aCwd, "a-only.txt"), "utf8")).toBe("from A");
    expect(await exists(join(repoDir, "a-only.txt"))).toBe(false);
    const aCheckout = client.view.current().checkout!;
    expect(aCheckout).toMatchObject({ conversationId: a, repo: await realpath(repoDir), subdir: "", base: head });
    expect(aCheckout.branch).toMatch(/^pinomad\//);

    const b = await startConversation(client, { kind: "project", path: repoDir }, "b");
    await settled(client, "b done");
    const bCwd = cwdOf(client);
    expect(bCwd).toBe(join(dataDir.path, "worktrees", String(b)));
    expect(client.view.current().checkout!.branch).not.toBe(aCheckout.branch);
    expect(await git(bCwd, ["rev-parse", "HEAD"])).toBe(head);
    expect(await exists(join(bCwd, "a-only.txt"))).toBe(false);
    expect(await exists(join(repoDir, "a-only.txt"))).toBe(false);
  });

  it("uses the project dir for checkout: project, non-git dirs, and repos without commits", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const plainDir = join(dir.path, "plain");
    await mkdir(plainDir, { recursive: true });
    const emptyRepo = join(dir.path, "empty");
    await mkdir(emptyRepo, { recursive: true });
    await run("git", ["-C", emptyRepo, "init", "-b", "main"]);
    const dataDir = await tempDir();
    defer(dataDir.remove);

    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir, plainDir, emptyRepo],
      answers: ["one", "two", "three"],
    });
    const client = await connectTo(defer, host);

    await client.controller.createConversation({ kind: "project", path: repoDir }, "one", { checkout: "project" });
    await settled(client, "one");
    expect(await realpath(cwdOf(client))).toBe(await realpath(repoDir));
    expect(client.view.current().checkout).toBeUndefined();

    await startConversation(client, { kind: "project", path: plainDir }, "two");
    await settled(client, "two");
    expect(await realpath(cwdOf(client))).toBe(await realpath(plainDir));
    expect(client.view.current().checkout).toBeUndefined();

    await startConversation(client, { kind: "project", path: emptyRepo }, "three");
    await settled(client, "three");
    expect(await realpath(cwdOf(client))).toBe(await realpath(emptyRepo));
    expect(client.view.current().checkout).toBeUndefined();

    const index = await host.harness.snapshot(IndexDoc, BACKGROUND_CONTEXT);
    expect(index?.checkouts ?? []).toEqual([]);
  });

  it("checks out the repo worktree with cwd at the project's subdirectory", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepoWithSub(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [join(repoDir, "sub")],
      answers: ["done"],
    });
    const client = await connectTo(defer, host);

    const id = await startConversation(client, { kind: "project", path: join(repoDir, "sub") }, "go");
    await settled(client, "done");
    const cwd = cwdOf(client);
    expect(cwd).toBe(join(dataDir.path, "worktrees", String(id), "sub"));
    expect(await readFile(join(cwd, "inner.txt"), "utf8")).toBe("inner\n");
    expect(client.view.current().checkout).toMatchObject({ repo: await realpath(repoDir), subdir: "sub" });
  });

  it("forks a worktree checkout with the parent's committed, dirty, and untracked state", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [coding],
      answers: ["parent done", "fork done"],
    });
    const client = await connectTo(defer, host);

    const parent = await startConversation(client, { kind: "project", path: repoDir }, "parent");
    await settled(client, "parent done");
    const parentCwd = cwdOf(client);
    const parentHead = await git(parentCwd, ["rev-parse", "HEAD"]);

    // Parent's checkout at fork time: a modified file, a deleted file, an
    // untracked file, and an ignored file (which must not travel).
    await writeFile(join(parentCwd, "tracked.txt"), "modified\n");
    await rm(join(parentCwd, "doomed.txt"));
    await writeFile(join(parentCwd, "untracked.txt"), "new\n");
    await writeFile(join(parentCwd, "secret.log"), "ignored\n");

    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork work");
    await settled(client, "fork done");
    const forkCwd = cwdOf(client);
    expect(forkCwd).toBe(join(dataDir.path, "worktrees", String(client.view.current().conversation!.conversation.id)));
    expect(forkCwd).not.toBe(parentCwd);

    expect(await readFile(join(forkCwd, "tracked.txt"), "utf8")).toBe("modified\n");
    expect(await exists(join(forkCwd, "doomed.txt"))).toBe(false);
    expect(await readFile(join(forkCwd, "untracked.txt"), "utf8")).toBe("new\n");
    expect(await exists(join(forkCwd, "secret.log"))).toBe(false);
    // Working state is pending: HEAD stays at the parent's commit.
    expect(await git(forkCwd, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(client.view.current().checkout!.branch).toMatch(/^pinomad\//);
    const status = await git(forkCwd, ["status", "--porcelain"]);
    expect(status).toContain("M tracked.txt");
    expect(status).toContain("D doomed.txt");
    expect(status).toContain("?? untracked.txt");

    // Later changes in the parent do not propagate.
    await writeFile(join(parentCwd, "tracked.txt"), "newer\n");
    expect(await readFile(join(forkCwd, "tracked.txt"), "utf8")).toBe("modified\n");
    void parent;
  });

  it("gives a project-dir fork a worktree too", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      answers: ["parent done", "fork done"],
    });
    const client = await connectTo(defer, host);

    await client.controller.createConversation({ kind: "project", path: repoDir }, "parent", { checkout: "project" });
    await settled(client, "parent done");
    expect(await realpath(cwdOf(client))).toBe(await realpath(repoDir));

    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork it");
    await settled(client, "fork done");
    const forkId = client.view.current().conversation!.conversation.id;
    expect(cwdOf(client)).toBe(join(dataDir.path, "worktrees", String(forkId)));
    expect(await exists(join(cwdOf(client), "tracked.txt"))).toBe(true);
  });

  it("recreates a removed worktree on the same branch, keeping its commits", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [coding],
      answers: ["first done", "second done"],
    });
    const client = await connectTo(defer, host);

    const id = await startConversation(client, { kind: "project", path: repoDir }, "first");
    await settled(client, "first done");
    const cwd = cwdOf(client);
    const branch = client.view.current().checkout!.branch;

    // The agent commits on its own branch, then the directory is wiped.
    await writeFile(join(cwd, "committed.txt"), "wip\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "wip"]);
    const wip = await git(cwd, ["rev-parse", "HEAD"]);
    await rm(cwd, { recursive: true, force: true });
    expect(await exists(cwd)).toBe(false);

    await client.controller.submit("second", "followUp");
    await settled(client, "second done");
    expect(await exists(cwd)).toBe(true);
    expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(wip);
    expect(await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
    expect(await readFile(join(cwd, "committed.txt"), "utf8")).toBe("wip\n");
  });

  it("removes clean worktrees on archive but keeps dirty ones with a warning", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      answers: ["a done", "fork done", "b done"],
    });
    const client = await connectTo(defer, host);

    // Top-level A plus a fork nested under it; both worktrees clean.
    const a = await startConversation(client, { kind: "project", path: repoDir }, "a");
    await settled(client, "a done");
    const aCwd = cwdOf(client);
    const aEntry = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(aEntry, "fork of a");
    await settled(client, "fork done");
    const forkCwd = cwdOf(client);
    const forkId = client.view.current().conversation!.conversation.id;

    // Top-level B with a dirty worktree.
    const b = await startConversation(client, { kind: "project", path: repoDir }, "b");
    await settled(client, "b done");
    const bCwd = cwdOf(client);
    await writeFile(join(bCwd, "dirty.txt"), "dirty\n");

    await client.controller.archive(a, true);
    await until(async () => !(await exists(aCwd)) && !(await exists(forkCwd)));
    // Branches are never deleted: unmerged work survives the cleanup.
    const branches = await git(repoDir, ["branch", "--list", "pinomad/*"]);
    expect(branches).toContain(`pinomad/${a}-`);
    expect(branches).toContain(`pinomad/${forkId}-`);

    await client.controller.archive(b, true);
    await waitForView(client.view, (view) => view.notices.some((notice) => notice.message.includes("Kept worktree")));
    expect(await exists(bCwd)).toBe(true);
    expect(client.view.current().notices.at(-1)!.message).toContain(bCwd);
  });

  it("tells the agent about the worktree and reads context files at both locations", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const outer = join(dir.path, "outer");
    const repoDir = join(outer, "repo");
    await initRepo(repoDir);
    await writeFile(join(outer, "AGENTS.md"), "outer rule");
    // Committed so the worktree carries it; the prompt must not pick the project-dir original.
    await writeFile(join(repoDir, "AGENTS.md"), "repo rule");
    await git(repoDir, ["add", "AGENTS.md"]);
    await git(repoDir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "agents"]);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    await writeFile(join(agentsHome.path, "AGENTS.md"), "global rule");
    const dataDir = await tempDir();
    defer(dataDir.remove);

    const prompts: string[] = [];
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [createContext({ agentsHome: agentsHome.path, checkout: checkoutInfo }), coding],
      answers: [capturePrompts(prompts)],
    });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: repoDir }, "hello");
    await settled(client, "captured-1");

    const prompt = prompts.at(-1)!;
    const count = (needle: string) => prompt.split(needle).length - 1;
    const branch = client.view.current().checkout!.branch;
    expect(prompt).toContain("git worktree");
    expect(prompt).toContain(branch);
    expect(prompt).toContain("must not be modified");
    expect(prompt).toContain(await realpath(repoDir));
    expect(count("outer rule")).toBe(1);
    expect(count("repo rule")).toBe(1);
    expect(count("global rule")).toBe(1);
  });

  it("creates worktrees for concurrent conversations on one repo", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      answers: ["one done", "two done"],
    });
    const raw = await socketTo(host);
    const home = { kind: "project" as const, path: repoDir };

    const [first, second] = await Promise.all([
      call(raw, "createConversation", { home, text: "one", requestId: "concurrent-1" }),
      call(raw, "createConversation", { home, text: "two", requestId: "concurrent-2" }),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const ids = [
      (first as { value: { conversationId: ConversationId } }).value.conversationId,
      (second as { value: { conversationId: ConversationId } }).value.conversationId,
    ];
    const paths = ids.map((id) => join(dataDir.path, "worktrees", String(id)));
    // Turns build their environments concurrently; the repo lock must keep both succeeding.
    await until(async () => (await exists(join(paths[0]!, ".git"))) && (await exists(join(paths[1]!, ".git"))));
    expect(await git(paths[0]!, ["rev-parse", "--abbrev-ref", "HEAD"])).toMatch(/^pinomad\//);
    expect(await git(paths[1]!, ["rev-parse", "--abbrev-ref", "HEAD"])).toMatch(/^pinomad\//);
    const listed = await git(repoDir, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(paths[0]);
    expect(listed).toContain(paths[1]);
  });
});
