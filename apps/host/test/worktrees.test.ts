// ADR-0010 behaviors: per-conversation worktrees, fork snapshots, lazy
// creation, archive cleanup — exercised end to end with real git in temp dirs.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type AgentState, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { coding } from "../src/extensions/coding.ts";
import { createContext } from "../src/extensions/context.ts";
import { createSubagent } from "../src/extensions/subagent.ts";
import { branchSuffix, worktreeBranch } from "../src/checkout.ts";
import { checkoutInfo, IndexDoc } from "../src/organization.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, startChat, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

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

  // ADR-0019 §1: a fork inherits its parent's agent state — same cwd — and the
  // host writes no snapshot, branch, or checkout record for it.
  it("a worktree fork shares the parent's checkout and its Changes resolve the parent's record", async () => {
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
    const parentCheckout = client.view.current().checkout!;
    const recordsBefore = (await host.harness.snapshot(IndexDoc, BACKGROUND_CONTEXT))?.checkouts?.length ?? 0;

    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork work");
    await settled(client, "fork done");
    const forkId = client.view.current().conversation!.conversation.id;
    expect(forkId).not.toBe(parent);
    expect(cwdOf(client)).toBe(parentCwd);

    // No new checkout record, no worktree directory of its own.
    const index = await host.harness.snapshot(IndexDoc, BACKGROUND_CONTEXT);
    expect(index?.checkouts).toHaveLength(recordsBefore);
    expect(await exists(join(dataDir.path, "worktrees", String(forkId)))).toBe(false);

    // The shared cwd resolves to the parent's record, so Changes reports the
    // parent's worktree diff while showing the fork.
    await writeFile(join(parentCwd, "shared.txt"), "from the fork's view\n");
    const changes = await client.controller.changes();
    expect(changes).toMatchObject({ available: true, base: parentCheckout.base });
    expect(changes.available ? changes.patch : "").toContain("shared.txt");
  });

  it("a project-dir fork shares the project directory", async () => {
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
    const parentCwd = cwdOf(client);
    expect(await realpath(parentCwd)).toBe(await realpath(repoDir));

    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork it");
    await settled(client, "fork done");
    expect(cwdOf(client)).toBe(parentCwd);
    const index = await host.harness.snapshot(IndexDoc, BACKGROUND_CONTEXT);
    expect(index?.checkouts ?? []).toEqual([]);
  });

  it("chat and non-git project forks share their parent's directory too", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const plainDir = join(dir.path, "plain");
    await mkdir(plainDir, { recursive: true });
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [plainDir],
      answers: ["chat done", "chat fork done", "plain done", "plain fork done"],
    });
    const client = await connectTo(defer, host);

    await startChat(client, "chat parent");
    await settled(client, "chat done");
    const chatCwd = cwdOf(client);
    await client.controller.fork(String(client.view.current().conversation!.entries.at(-1)!.id), "chat fork");
    await settled(client, "chat fork done");
    expect(cwdOf(client)).toBe(chatCwd);

    await startConversation(client, { kind: "project", path: plainDir }, "plain parent");
    await settled(client, "plain done");
    const plainCwd = cwdOf(client);
    await client.controller.fork(String(client.view.current().conversation!.entries.at(-1)!.id), "plain fork");
    await settled(client, "plain fork done");
    expect(cwdOf(client)).toBe(plainCwd);
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
      answers: ["a done", "fork done", "fork again done", "b done"],
    });
    const client = await connectTo(defer, host);

    // Top-level A plus a fork nested under it; both worktrees clean. Forks made
    // before ADR-0019 carry their own checkout record — give this one a record
    // and a cwd of its own so archiving still exercises the subtree cleanup.
    const a = await startConversation(client, { kind: "project", path: repoDir }, "a");
    await settled(client, "a done");
    const aCwd = cwdOf(client);
    const aBase = client.view.current().checkout!.base;
    const aEntry = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(aEntry, "fork of a");
    await settled(client, "fork done");
    const forkId = client.view.current().conversation!.conversation.id;
    expect(cwdOf(client)).toBe(aCwd);
    const forkCwd = join(dataDir.path, "worktrees", String(forkId));
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(IndexDoc);
      if (doc.checkouts === undefined) doc.checkouts = [];
      doc.checkouts.push({
        conversationId: forkId,
        path: forkCwd,
        repo: await realpath(repoDir),
        subdir: "",
        branch: worktreeBranch(forkId, branchSuffix()),
        base: aBase,
      });
      (await tx.doc(AgentDoc, forkId)).cwd = forkCwd;
    }, BACKGROUND_CONTEXT);
    await client.controller.submit("again", "followUp");
    await settled(client, "fork again done");
    expect(await exists(forkCwd)).toBe(true);

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
    // The resolver reads conversation records, so it needs the host's harness —
    // bound lazily because extensions exist before it does.
    let harness: Harness | undefined;
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [
        createContext({ agentsHome: agentsHome.path, checkout: (input, ctx) => checkoutInfo(harness!, input, ctx) }),
        coding,
      ],
      answers: [capturePrompts(prompts)],
    });
    harness = host.harness;
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

  // ADR-0019 §2: forks and subagent conversations cannot be forked again.
  it("rejects forking a fork or a subagent's conversation", async () => {
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      extensions: ({ models, modelSummaries }: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
        createSubagent({ models, modelSummaries, exclude: [] }),
      ],
      answers: [
        "parent done",
        "fork done",
        fauxAssistantMessage(fauxToolCall("subagent", { task: "look around" }), { stopReason: "toolUse" }),
        "child answer",
        "parent final",
      ],
    });
    const client = await connectTo(defer, host);

    const parentId = await startChat(client, "parent");
    await settled(client, "parent done");
    const parentEntry = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(parentEntry, "fork");
    await settled(client, "fork done");
    const forkId = client.view.current().conversation!.conversation.id;

    await client.controller.switchConversation(parentId);
    await client.controller.submit("delegate", "followUp");
    await settled(client, "parent final");
    const childId = client.view.current().organized.chats.find((node) => node.summary.id === parentId)!.children[0]!.summary.id;

    const entryOf = async (id: ConversationId): Promise<string> => {
      const conversation = (await host.harness.conversation(id, BACKGROUND_CONTEXT))!;
      const page = await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
      return String(page.items[0]!.id);
    };
    const raw = await socketTo(host);
    for (const id of [forkId, childId]) {
      const result = await call(raw, "fork", { conversationId: id, entryId: await entryOf(id) });
      expect(result).toMatchObject({ ok: false, error: "Only top-level conversations can be forked" });
    }

    // The client path surfaces the same failure as a notice.
    await client.controller.switchConversation(forkId);
    await client.controller.fork(await entryOf(forkId), "second level");
    await waitForView(client.view, (view) =>
      view.notices.some((notice) => notice.message === "Only top-level conversations can be forked"),
    );
  });

  // ADR-0019 §3: one fork per message — two parallel calls must not both land.
  it("allows exactly one fork per message, even under parallel calls", async () => {
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, { dataDir: dataDir.path, answers: ["parent done"] });
    const client = await connectTo(defer, host);

    const parentId = await startChat(client, "parent");
    await settled(client, "parent done");
    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);

    // Two sockets = two gateway clients: the check must be serialized across them.
    const first = await socketTo(host);
    const second = await socketTo(host);
    const [a, b] = await Promise.all([
      call(first, "fork", { conversationId: parentId, entryId }),
      call(second, "fork", { conversationId: parentId, entryId }),
    ]);
    const results = [a, b];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, error: "This message already has a fork" });

    // A later attempt fails the same way.
    const again = await call(first, "fork", { conversationId: parentId, entryId });
    expect(again).toMatchObject({ ok: false, error: "This message already has a fork" });
  });

  // ADR-0019 consequence: the summary carries the fork point for the client's "open the fork" path.
  it("carries the fork point in the conversation summary", async () => {
    const host = await startFauxHost(defer, { answers: ["parent done", "fork done"] });
    const client = await connectTo(defer, host);

    await startChat(client, "parent");
    await settled(client, "parent done");
    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork");
    await settled(client, "fork done");

    const fork = client.view.current().organized.chats.flatMap((node) => node.children)[0]!.summary;
    expect(fork.kind).toBe("fork");
    expect(fork.forkedAt).toBe(entryId);
  });

  // ADR-0019 consequences for the prompt: shared checkouts say so plainly.
  it("tells a worktree fork it shares the parent's working directory", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const prompts: string[] = [];
    let harness: Harness | undefined;
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [
        createContext({ agentsHome: agentsHome.path, checkout: (input, ctx) => checkoutInfo(harness!, input, ctx) }),
        coding,
      ],
      answers: [capturePrompts(prompts), capturePrompts(prompts)],
    });
    harness = host.harness;
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: repoDir }, "parent");
    await settled(client, "captured-1");
    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork work");
    await settled(client, "captured-2");

    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("git worktree PiNomad created for the conversation this one belongs to");
    expect(prompt).toContain("The user's project directory is");
    expect(prompt).toContain("fresh checkout");
    expect(prompt).toContain("This conversation is a fork: it shares this working directory");
  });

  it("tells a Chat fork it shares the working directory", async () => {
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    const prompts: string[] = [];
    let harness: Harness | undefined;
    const host = await startFauxHost(defer, {
      extensions: [createContext({ agentsHome: agentsHome.path, checkout: (input, ctx) => checkoutInfo(harness!, input, ctx) })],
      answers: [capturePrompts(prompts), capturePrompts(prompts)],
    });
    harness = host.harness;
    const client = await connectTo(defer, host);

    await startChat(client, "parent");
    await settled(client, "captured-1");
    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork work");
    await settled(client, "captured-2");

    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("This conversation is a fork: it shares this working directory");
  });

  it("tells a worktree subagent the checkout belongs to its owner, without the fork line", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const prompts: string[] = [];
    let harness: Harness | undefined;
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: ({ models, modelSummaries }: { models: Models; modelSummaries: () => readonly ModelSummary[] }) => [
        createContext({ agentsHome: agentsHome.path, checkout: (input, ctx) => checkoutInfo(harness!, input, ctx) }),
        createSubagent({ models, modelSummaries, exclude: [] }),
      ],
      answers: [
        fauxAssistantMessage(fauxToolCall("subagent", { task: "look around" }), { stopReason: "toolUse" }),
        capturePrompts(prompts),
        "parent final",
      ],
    });
    harness = host.harness;
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: repoDir }, "delegate");
    await settled(client, "parent final");

    // Only the child's request is served by capturePrompts — it's prompts[0].
    const childPrompt = prompts[0]!;
    expect(childPrompt).toContain("git worktree PiNomad created for the conversation this one belongs to");
    expect(childPrompt).not.toContain("This conversation is a fork");
  });

  it("keeps today's prompt for a fork that owns a worktree record (pre-ADR)", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const agentsHome = await tempDir();
    defer(agentsHome.remove);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const prompts: string[] = [];
    let harness: Harness | undefined;
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      extensions: [
        createContext({ agentsHome: agentsHome.path, checkout: (input, ctx) => checkoutInfo(harness!, input, ctx) }),
        coding,
      ],
      answers: [capturePrompts(prompts), capturePrompts(prompts), capturePrompts(prompts)],
    });
    harness = host.harness;
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: repoDir }, "parent");
    await settled(client, "captured-1");
    const parentBase = client.view.current().checkout!.base;
    const entryId = String(client.view.current().conversation!.entries.at(-1)!.id);
    await client.controller.fork(entryId, "fork work");
    await settled(client, "captured-2");
    const forkId = client.view.current().conversation!.conversation.id;

    // Forks created before ADR-0019 keep a worktree record of their own — attach
    // one so this conversation renders like a pre-ADR fork.
    const forkCwd = join(dataDir.path, "worktrees", String(forkId));
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(IndexDoc);
      if (doc.checkouts === undefined) doc.checkouts = [];
      doc.checkouts.push({
        conversationId: forkId,
        path: forkCwd,
        repo: await realpath(repoDir),
        subdir: "",
        branch: worktreeBranch(forkId, branchSuffix()),
        base: parentBase,
      });
      (await tx.doc(AgentDoc, forkId)).cwd = forkCwd;
    }, BACKGROUND_CONTEXT);
    await client.controller.submit("again", "followUp");
    await settled(client, "captured-3");

    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("git worktree PiNomad created for this conversation");
    expect(prompt).not.toContain("This conversation is a fork");
  });
});
