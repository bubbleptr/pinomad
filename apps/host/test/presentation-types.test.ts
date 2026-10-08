import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { CallMethods, ServerFrame } from "@pinomad/protocol/frames.ts";
import { classify } from "@pinomad/protocol/presentation.ts";
import type { QuestionState, TodoState } from "@pinomad/protocol/presentation.ts";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { changesOf } from "../src/checkout.ts";
import { coding } from "../src/extensions/coding.ts";
import { question } from "../src/extensions/question.ts";
import { todo } from "../src/extensions/todo.ts";
import type { OpenedHost } from "../src/host.ts";
import { connectTo, freePort, startChat, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const run = promisify(execFile);
const git = (dir: string, args: readonly string[]) => run("git", ["-C", dir, ...args]).then(({ stdout }) => stdout.trim());

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["-C", path, "init", "-b", "main"]);
  await writeFile(join(path, "tracked.txt"), "tracked\n");
  await writeFile(join(path, "doomed.txt"), "doomed\n");
  await writeFile(join(path, ".gitignore"), "*.log\n");
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
}

let nextCall = 1;

/** A raw client that can observe call results, which controller methods deliberately hide. */
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

const answer = (
  client: { socket: WebSocket; frames: ServerFrame[] },
  conversationId: ConversationId,
  requestId: string,
  answers: CallMethods["answer"]["args"]["answers"],
  kind = "question.requests",
) => call(client, "answer", { conversationId, kind, requestId, answers });

const docValue = <T>(view: DurableView, kind: string): T | null | undefined =>
  view.docs.find((doc) => doc.kind === kind)?.value as T | null | undefined;

const requestsOf = (view: DurableView): QuestionState["requests"] =>
  docValue<QuestionState>(view, "question.requests")?.requests ?? [];

const pendingOf = (view: DurableView): QuestionState["requests"] =>
  requestsOf(view).filter((request) => request.resolution === undefined);

const ASK = {
  questions: [
    {
      header: "Direction",
      question: "Which approach should I take?",
      options: [
        { label: "Refactor", description: "Rework the module" },
        { label: "Patch", description: "Minimal fix" },
      ],
    },
  ],
};

const toolResultTexts = (view: DurableView): string[] =>
  view.conversation!.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));

describe("presentation types", () => {
  it("presents a todo_write call as a pinomad.todo document", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, question],
      answers: [
        fauxAssistantMessage(
          fauxToolCall("todo_write", {
            items: [
              { text: "Investigate the report", status: "in_progress" },
              { text: "Ship the fix", status: "pending" },
            ],
          }),
          { stopReason: "toolUse" },
        ),
        "planned",
      ],
    });
    const client = await connectTo(defer, host);

    await startChat(client, "plan it");
    await waitForView(client.view, (view) => (docValue<TodoState>(view, "todo.list")?.items.length ?? 0) === 2);
    await waitForView(client.view, (view) => transcript(view.conversation!).at(-1)?.text === "planned");

    const doc = client.view.current().docs.find((each) => each.kind === "todo.list");
    expect(doc).toMatchObject({ kind: "todo.list", presentation: "pinomad.todo" });
    expect(docValue<TodoState>(client.view.current(), "todo.list")?.items).toEqual([
      { text: "Investigate the report", status: "in_progress" },
      { text: "Ship the fix", status: "pending" },
    ]);
  });

  it("blocks the turn until answered, then formats the answers for the model; second answer is a no-op", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, question],
      answers: [
        fauxAssistantMessage(
          fauxToolCall("ask_user_question", {
            questions: [
              ...ASK.questions,
              {
                header: "Scope",
                question: "Which parts?",
                multiSelect: true,
                options: [{ label: "Core" }, { label: "Tests" }, { label: "Docs" }],
              },
            ],
          }),
          { stopReason: "toolUse" },
        ),
        "proceeding",
      ],
    });
    const client = await connectTo(defer, host);

    const conversationId = await startChat(client, "need a decision");
    await waitForView(client.view, (view) => pendingOf(view).length === 1);
    const requestId = pendingOf(client.view.current())[0]!.id;
    // The turn waits on the answer: still busy.
    expect(isBusy(client.view.current().conversation!)).toBe(true);

    const first = await answer(await socketTo(host), conversationId, requestId, [
      { selected: ["Refactor"] },
      { selected: ["Core", "Tests"], other: "keep docs out" },
    ]);
    expect(first).toMatchObject({ ok: true, value: { first: true } });
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "proceeding");

    // The tool result carries the formatted answers for the model.
    const results = toolResultTexts(client.view.current());
    expect(results.at(-1)).toContain("Direction: Refactor");
    expect(results.at(-1)).toContain("Scope: Core, Tests");
    expect(results.at(-1)).toContain("keep docs out");

    const stored = requestsOf(client.view.current()).find((request) => request.id === requestId)!;
    const second = await answer(await socketTo(host), conversationId, requestId, [{ selected: ["Patch"] }, { selected: ["Docs"] }]);
    expect(second).toMatchObject({ ok: true, value: { first: false } });
    expect(requestsOf(client.view.current()).find((request) => request.id === requestId)!.resolution).toEqual(stored.resolution);
  });

  it("rejects answers for unknown requests, wrong counts, unknown labels, and extra selections", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, question],
      answers: [fauxAssistantMessage(fauxToolCall("ask_user_question", ASK), { stopReason: "toolUse" })],
    });
    const owner = await connectTo(defer, host);
    const conversationId = await startChat(owner, "ask me");
    await waitForView(owner.view, (view) => pendingOf(view).length === 1);
    const requestId = pendingOf(owner.view.current())[0]!.id;
    const client = await socketTo(host);

    expect(await answer(client, conversationId, "missing-request", [{ selected: ["Refactor"] }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing-request"),
    });
    expect(await answer(client, conversationId, requestId, [])).toMatchObject({ ok: false });
    expect(await answer(client, conversationId, requestId, [{ selected: ["Refactor"] }, { selected: [] }])).toMatchObject({ ok: false });
    expect(await answer(client, conversationId, requestId, [{ selected: ["No such option"] }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("No such option"),
    });
    expect(await answer(client, conversationId, requestId, [{ selected: ["Refactor", "Patch"] }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("single"),
    });
    // Wrong-kind docs do not accept answers; the connection stays usable.
    expect(await answer(client, conversationId, requestId, [{ selected: ["Refactor"] }], "todo.list")).toMatchObject({ ok: false });
    expect(requestsOf(owner.view.current()).find((request) => request.id === requestId)!.resolution).toBeUndefined();
  });

  it("cancels a pending request when the turn is aborted", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, question],
      answers: [
        fauxAssistantMessage(fauxToolCall("ask_user_question", ASK), { stopReason: "toolUse" }),
        "should not be reached",
      ],
    });
    const client = await connectTo(defer, host);

    const conversationId = await startChat(client, "ask me");
    await waitForView(client.view, (view) => pendingOf(view).length === 1);
    const requestId = pendingOf(client.view.current())[0]!.id;

    await client.controller.abort();
    await waitForView(client.view, (view) => !isBusy(view.conversation!));

    const request = requestsOf(client.view.current()).find((request) => request.id === requestId)!;
    expect(request.resolution).toMatchObject({ outcome: "cancelled" });
    const later = await answer(await socketTo(host), conversationId, requestId, [{ selected: ["Refactor"] }]);
    expect(later).toMatchObject({ ok: true, value: { first: false } });
  });

  it("keeps the pending request across a host restart; answering completes the turn", async () => {
    const port = await freePort();
    const first = await startFauxHost(defer, {
      extensions: [todo, question],
      port,
      answers: [fauxAssistantMessage(fauxToolCall("ask_user_question", ASK), { stopReason: "toolUse" })],
    });
    const client = await connectTo(defer, first);
    const conversationId = await startChat(client, "ask me");
    await waitForView(client.view, (view) => pendingOf(view).length === 1);
    const dataDir = client.view.current().session.directory;
    await first.close();
    await waitForView(client.view, (view) => view.connection === "reconnecting");

    const second = await startFauxHost(defer, {
      extensions: [todo, question],
      port,
      dataDir,
      answers: ["done"],
    });
    expect(second.token).toBe(first.token);
    await waitForView(client.view, (view) => view.connection === "connected");
    await waitForView(client.view, (view) => {
      const pending = pendingOf(view);
      const requests = requestsOf(view);
      return requests.length === 1 && pending.length === 1;
    });
    const requestId = pendingOf(client.view.current())[0]!.id;

    const replied = await answer(await socketTo(second), conversationId, requestId, [{ selected: ["Patch"] }]);
    expect(replied).toMatchObject({ ok: true, value: { first: true } });
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done");
  });

  it("dismisses a pending question when the user submits a message instead", async () => {
    const host = await startFauxHost(defer, {
      extensions: [todo, question],
      answers: [
        fauxAssistantMessage(fauxToolCall("ask_user_question", ASK), { stopReason: "toolUse" }),
        "got your message",
      ],
    });
    const client = await connectTo(defer, host);

    await startChat(client, "ask me");
    await waitForView(client.view, (view) => pendingOf(view).length === 1);
    const requestId = pendingOf(client.view.current())[0]!.id;

    // Even a followUp goes in as a steer: the pending question must not block input.
    await client.controller.submit("skip it, just do the simple thing", "followUp");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "got your message");

    expect(requestsOf(client.view.current()).find((request) => request.id === requestId)!.resolution).toMatchObject({
      outcome: "dismissed",
    });
    const results = toolResultTexts(client.view.current());
    expect(results.at(-1)).toContain("replied in the conversation instead");
    // The submitted text is a user entry following the dismissed tool.
    const lines = transcript(client.view.current().conversation!);
    expect(lines.filter((line) => line.role === "user").map((line) => line.text)).toContain("skip it, just do the simple thing");
  });
});

describe("tool result details and changes", () => {
  it("announces edit/write as pinomad.diff in the hello", async () => {
    const host = await startFauxHost(defer, { extensions: [coding] });
    const client = await socketTo(host);
    // The hello arrives on a later tick than `open`; poll the frame buffer.
    let hello: ServerFrame | undefined;
    while (hello === undefined) {
      hello = client.frames.find((frame) => frame.type === "hello");
      if (hello === undefined) await once(client.socket, "message");
    }
    expect(hello).toBeDefined();
    expect((hello as { toolPresentations: Record<string, string> }).toolPresentations).toMatchObject({
      edit: "pinomad.diff",
      write: "pinomad.diff",
    });
  });

  it("wraps write results with a patch and keeps the text result; edit details classify", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dir.path,
      projects: [dir.path],
      extensions: [coding],
      answers: [
        fauxAssistantMessage(fauxToolCall("write", { path: "fresh.txt", content: "one\ntwo\n" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("write", { path: "fresh.txt", content: "one\nthree\n" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("edit", { path: "fresh.txt", edits: [{ oldText: "three", newText: "four" }] }), {
          stopReason: "toolUse",
        }),
        "edits done",
      ],
    });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: dir.path }, "write and edit");
    await waitForView(client.view, (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "edits done");

    const results = client.view.current().conversation!.entries.filter((entry) => entry.kind === "pi.tool-result");
    expect(results).toHaveLength(3);
    const details = results.map((entry) => (entry.model?.[0] as { details?: unknown }).details);
    for (const detail of details) expect(classify("pinomad.diff", detail).type).toBe("pinomad.diff");

    // New file: every line added. Overwrite: one line changed.
    const [created, overwritten] = details as { patch: string }[];
    expect(created.patch).toContain("+one");
    expect(created.patch).toContain("+two");
    expect(created.patch).not.toContain("-one");
    expect(overwritten.patch).toContain("-two");
    expect(overwritten.patch).toContain("+three");
    // The text result is what the plain tool produces.
    expect(JSON.stringify(results[0]!.model)).toContain("Successfully wrote");
  });

  it("reports a worktree conversation's committed and pending changes, not ignored files", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const host = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [repoDir],
      answers: ["done"],
    });
    const client = await connectTo(defer, host);

    await startConversation(client, { kind: "project", path: repoDir }, "work");
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    const cwd = (client.view.current().conversation!.docs["pi.agent"] as { cwd: string }).cwd;

    // A commit on the branch plus uncommitted, deleted, untracked, and ignored state.
    await writeFile(join(cwd, "committed.txt"), "committed\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "wip"]);
    await writeFile(join(cwd, "tracked.txt"), "modified\n");
    await rm(join(cwd, "doomed.txt"));
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    await writeFile(join(cwd, "secret.log"), "ignored\n");

    const result = await client.controller.changes();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.patch).toContain("committed.txt");
    expect(result.patch).toContain("-doomed");
    expect(result.patch).toContain("+modified");
    expect(result.patch).toContain("+new");
    expect(result.patch).not.toContain("secret.log");
    expect(result.patch).not.toContain(".log");
  });

  it("reports a project dir's uncommitted diff and declines chats", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const host = await startFauxHost(defer, { projects: [repoDir], answers: ["one", "two"] });
    const client = await connectTo(defer, host);

    await client.controller.createConversation({ kind: "project", path: repoDir }, "direct", { checkout: "project" });
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    await writeFile(join(repoDir, "tracked.txt"), "modified\n");

    const direct = await client.controller.changes();
    expect(direct.available).toBe(true);
    if (direct.available) {
      expect(direct.patch).toContain("tracked.txt");
      expect(direct.patch).toContain("+modified");
      expect(direct.base).toBe(await git(repoDir, ["rev-parse", "HEAD"]));
    }

    await startChat(client, "chat");
    await waitForView(client.view, (view) => !isBusy(view.conversation!));
    const chat = await client.controller.changes();
    expect(chat).toMatchObject({ available: false, reason: "Chat conversations have no repository" });
  });

  it("truncates a large diff and flags it", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const repoDir = join(dir.path, "repo");
    await initRepo(repoDir);
    const base = await git(repoDir, ["rev-parse", "HEAD"]);
    await writeFile(join(repoDir, "big.txt"), "line\n".repeat(2000));

    const full = await changesOf(repoDir, base);
    expect(full.truncated).toBe(false);
    const small = await changesOf(repoDir, base, 2000);
    expect(small.truncated).toBe(true);
    expect(small.patch.length).toBeLessThanOrEqual(2000);
    expect(small.patch).toContain("big.txt");
  });
});
