import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationDocToken, ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { QuestionState } from "@pinomad/protocol/presentation.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import { addInboxEvent, addTimer, InboxDoc, type InboxTask, TimerDoc } from "../src/inbox.ts";
import { IndexDoc } from "../src/organization.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups } from "./support.ts";

const context = BACKGROUND_CONTEXT;
// The question extension's document, as the host hands it to the Inbox.
const QuestionDoc = question.docs![0]!.token as ConversationDocToken<QuestionState>;
const defer = useCleanups();
const exec = promisify(execFile);

async function gitProject(): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir.path });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir.path });
  return dir.path;
}

async function plainProject(): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  return dir.path;
}

const tasksOf = async (host: OpenedHost, project: string): Promise<InboxTask[]> => {
  const doc = await host.harness.snapshot(InboxDoc, context);
  const inbox = Object.entries(doc?.inboxes ?? {}).find(([path]) => path.endsWith(project.split("/").pop()!))?.[1];
  return inbox?.tasks ?? [];
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const event = (id: string, summary: string) => ({ id, source: "user" as const, summary, trusted: true });

async function userTexts(host: OpenedHost, id: ConversationId): Promise<string[]> {
  const conversation = await host.harness.conversation(id, context);
  const page = await conversation!.entries({ order: "ascending" }, 1000, undefined, context);
  return page.items
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => JSON.stringify((entry as { model?: unknown }).model));
}

async function answerPending(host: OpenedHost, id: ConversationId): Promise<void> {
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(QuestionDoc, id);
    for (const request of doc.requests) {
      if (request.resolution === undefined) {
        request.resolution = {
          outcome: "answered",
          answers: request.questions.map((q) => ({ selected: [q.options[0]!.label] })),
          at: Date.now(),
        };
      }
    }
  }, context);
}

const asks = () =>
  fauxAssistantMessage(
    fauxToolCall("ask_user_question", {
      questions: [{ header: "Layout", question: "Change desktop too?", options: [{ label: "Yes" }, { label: "No" }] }],
    }),
    { stopReason: "toolUse" },
  );

describe("Inbox", () => {
  it("runs a project's tasks one at a time, in arrival order", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: [LONG_ANSWER, "two", "three"], tokensPerSecond: 40 });
    await addInboxEvent(host.harness, project, event("e1", "bug one"), context);
    await addInboxEvent(host.harness, project, event("e2", "bug two"), context);
    await addInboxEvent(host.harness, project, event("e3", "bug three"), context);

    const first = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.conversationId !== undefined);
    expect(first).toHaveLength(3);
    // The first task is still streaming its long answer: nothing else has started.
    expect(first[1]!.conversationId).toBeUndefined();
    expect(first[2]!.conversationId).toBeUndefined();

    const done = await until(() => tasksOf(host, project), (tasks) => tasks.length === 3 && tasks.every((task) => task.closed));
    const ids = done.map((task) => task.conversationId!);
    expect(new Set(ids).size).toBe(3);
    expect(await userTexts(host, ids[1]!)).toEqual([expect.stringContaining("bug two")]);
  });

  it("makes one task for a repeated event id", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["ok"] });
    const a = await addInboxEvent(host.harness, project, event("same", "bug"), context);
    const b = await addInboxEvent(host.harness, project, event("same", "bug"), context);
    expect(b).toEqual({ ...a, duplicate: true });
    const tasks = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.events).toHaveLength(1);
  });

  it("routes an event with a known thread to the task that registered it, reopening it", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["fixed", "looked at CI"] });
    await addInboxEvent(host.harness, project, { ...event("issue-1", "issue opened"), thread: "github:acme/web#1" }, context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    await addInboxEvent(host.harness, project, { ...event("ci-1", "CI failed"), thread: "github:acme/web#1" }, context);
    const after = await until(() => tasksOf(host, project), (tasks) => tasks[0]!.events.length === 2 && tasks[0]!.closed);
    expect(after).toHaveLength(1);
    const texts = await userTexts(host, task!.conversationId!);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("CI failed");
  });

  it("loses nothing and repeats nothing across a restart mid-queue", async () => {
    const project = await plainProject();
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, { dataDir: dir.path, projects: [project], answers: [LONG_ANSWER], tokensPerSecond: 20 });
    await addInboxEvent(first.harness, project, event("e1", "bug one"), context);
    await addInboxEvent(first.harness, project, event("e2", "bug two"), context);
    await until(() => tasksOf(first, project), (tasks) => tasks[0]?.conversationId !== undefined);
    await first.close();

    const second = await startFauxHost(defer, { dataDir: dir.path, projects: [project], answers: ["one again", "two"] });
    const done = await until(() => tasksOf(second, project), (tasks) => tasks.length === 2 && tasks.every((task) => task.closed));
    expect(await userTexts(second, done[0]!.conversationId!)).toHaveLength(1);
    expect(await userTexts(second, done[1]!.conversationId!)).toEqual([expect.stringContaining("bug two")]);
  });

  it("finishes a run resumed after a restart before starting another task in a non-git project", async () => {
    const project = await plainProject();
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, { dataDir: dir.path, projects: [project], answers: [LONG_ANSWER], tokensPerSecond: 20 });
    await addInboxEvent(first.harness, project, { ...event("a1", "bug A"), thread: "a" }, context);
    await until(() => tasksOf(first, project), (tasks) => tasks[0]?.batch?.admitted === true);
    // B waits longer than A's follow-up, which arrives while A runs.
    await addInboxEvent(first.harness, project, event("b1", "bug B"), context);
    await addInboxEvent(first.harness, project, { ...event("a2", "more on A"), thread: "a" }, context);
    await first.close();

    const second = await startFauxHost(defer, { dataDir: dir.path, projects: [project], answers: [LONG_ANSWER, "b done", "a2 done"], tokensPerSecond: 20 });
    let overlapped = false;
    const done = await until(
      () => tasksOf(second, project),
      (tasks) => {
        const [a, b] = tasks;
        // B started while A's first batch had not been seen to settle.
        if (b?.conversationId !== undefined && a?.batch?.eventIds.includes("a1") === true) overlapped = true;
        return tasks.length === 2 && tasks.every((task) => task.closed);
      },
      30_000,
    );
    expect(overlapped).toBe(false);
    expect(await userTexts(second, done[0]!.conversationId!)).toHaveLength(2);
  });

  it("takes the next task while one waits for an answer in a git project", async () => {
    const project = await gitProject();
    const host = await startFauxHost(defer, { projects: [project], extensions: [question], answers: [asks(), "second done", "first done"] });
    await addInboxEvent(host.harness, project, event("e1", "needs a decision"), context);
    await addInboxEvent(host.harness, project, event("e2", "plain bug"), context);
    const tasks = await until(() => tasksOf(host, project), (tasks) => tasks[1]?.closed === true);
    expect(tasks[0]!.closed).toBe(false);
    await answerPending(host, tasks[0]!.conversationId!);
    await until(() => tasksOf(host, project), (tasks) => tasks[0]!.closed);
  });

  it("pauses a non-git project's Inbox while a task waits for an answer", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], extensions: [question], answers: [asks(), "first done", "second done"] });
    await addInboxEvent(host.harness, project, event("e1", "needs a decision"), context);
    await addInboxEvent(host.harness, project, event("e2", "plain bug"), context);
    const waiting = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.conversationId !== undefined);
    const id = waiting[0]!.conversationId!;
    await until(
      async () => ((await host.harness.snapshot(QuestionDoc, id, context))?.requests.length ?? 0),
      (count) => count === 1,
    );
    expect((await tasksOf(host, project))[1]!.conversationId).toBeUndefined();
    await answerPending(host, id);
    const done = await until(() => tasksOf(host, project), (tasks) => tasks.every((task) => task.closed));
    // The second task's conversation was only created after the answer.
    const answeredAt = (await host.harness.snapshot(QuestionDoc, id, context))!.requests[0]!.resolution!.at;
    const index = await host.harness.snapshot(IndexDoc, context);
    const secondCreated = index!.conversations.find((entry) => entry.id === done[1]!.conversationId)!.createdAt;
    expect(secondCreated).toBeGreaterThanOrEqual(answeredAt);
  });

  it("closes a stopped task and goes on to the next", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: [LONG_ANSWER, "second done"], tokensPerSecond: 20 });
    await addInboxEvent(host.harness, project, event("e1", "long one"), context);
    await addInboxEvent(host.harness, project, event("e2", "next one"), context);
    const started = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.conversationId !== undefined);
    await (await host.harness.conversation(started[0]!.conversationId!, context))!.abort(context);
    const done = await until(() => tasksOf(host, project), (tasks) => tasks.every((task) => task.closed));
    expect(done[1]!.conversationId).toBeDefined();
  });

  it("admits a batch recorded before a crash exactly once", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["done"] });
    const key = Object.keys((await host.harness.snapshot(InboxDoc, context))?.inboxes ?? {})[0];
    expect(key).toBeUndefined();
    // As a crash between recording the batch and admitting it leaves it.
    await host.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDoc);
      const path = index.projects[0]!.path;
      (await tx.doc(InboxDoc)).inboxes[path] = {
        threads: {},
        tasks: [
          {
            id: "t1",
            title: "seeded",
            createdAt: Date.now(),
            closed: false,
            events: [{ id: "e1", source: "user", summary: "seeded bug", trusted: true, receivedAt: Date.now(), handled: false }],
            batch: { requestId: "inbox:t1:e1", eventIds: ["e1"], first: true, admitted: false },
          },
        ],
      };
    }, context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(await userTexts(host, task!.conversationId!)).toEqual([expect.stringContaining("seeded bug")]);
  });

  it("refuses an event for a project the host does not know", async () => {
    const host = await startFauxHost(defer);
    await expect(addInboxEvent(host.harness, await plainProject(), event("e1", "bug"), context)).rejects.toThrow(/Unknown project/);
  });
});

describe("Inbox timers", () => {
  const timersOf = async (host: OpenedHost) => (await host.harness.snapshot(TimerDoc, context))?.timers ?? [];

  it("fires a schedule into the Inbox as a new task each time, once per due time", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["first", "second"] });
    const start = Date.now();
    await addTimer(host.harness, project, { due: start + 200, every: 400, note: "daily digest" }, context);
    const tasks = await until(() => tasksOf(host, project), (tasks) => tasks.length >= 2 && tasks[0]!.closed);
    expect(tasks.slice(0, 2).map((task) => task.events[0]!.source)).toEqual(["schedule", "schedule"]);
    expect(await userTexts(host, tasks[0]!.conversationId!)).toEqual([expect.stringContaining("daily digest")]);
    // Each fire moved the due time on; none is in the past.
    const [timer] = await timersOf(host);
    expect(timer!.due).toBeGreaterThan(start + 400);
  });

  it("fires a schedule that came due while the host was down once, not once per missed time", async () => {
    const project = await plainProject();
    const dir = await tempDir();
    defer(dir.remove);
    const first = await startFauxHost(defer, { dataDir: dir.path, projects: [project], answers: [] });
    // As if the host slept through five due times.
    await addTimer(first.harness, project, { due: Date.now() - 5 * 60_000 + 1_000, every: 60_000, note: "missed" }, context);
    await first.close();

    const second = await startFauxHost(defer, { dataDir: dir.path, projects: [project], answers: ["ran"] });
    await until(() => tasksOf(second, project), (tasks) => tasks[0]?.closed === true);
    expect(await tasksOf(second, project)).toHaveLength(1);
    expect((await timersOf(second))[0]!.due).toBeGreaterThan(Date.now());
  });

  it("wakes a task at the time it set with wake_me_at, in the same conversation", async () => {
    const project = await plainProject();
    const at = new Date(Date.now() + 500).toISOString();
    const wake = fauxAssistantMessage(fauxToolCall("wake_me_at", { at, note: "check CI on the PR" }), { stopReason: "toolUse" });
    const host = await startFauxHost(defer, { projects: [project], answers: [wake, "will check later", "CI is green"] });
    await addInboxEvent(host.harness, project, event("e1", "fix the flaky test"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.events.length === 2 && tasks[0]!.closed);
    expect(task!.events[1]).toMatchObject({ source: "followUp", handled: true });
    const texts = await userTexts(host, task!.conversationId!);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("check CI on the PR");
    expect(await timersOf(host)).toEqual([expect.objectContaining({ task: task!.id, done: true })]);
  });

  it("keeps a follow-up of a task that read outside content untrusted", async () => {
    const project = await plainProject();
    const wake = fauxAssistantMessage(fauxToolCall("wake_me_at", { in_minutes: 0.01, note: "look again" }), { stopReason: "toolUse" });
    const host = await startFauxHost(defer, { projects: [project], answers: [wake, "later", "looked"] });
    await addInboxEvent(host.harness, project, { ...event("issue-1", "issue opened by a stranger"), trusted: false }, context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.events.length === 2 && tasks[0]!.closed);
    expect(task!.events[1]).toMatchObject({ source: "followUp", trusted: false });
  });

  it("offers wake_me_at to an Inbox task's conversation and not to an ordinary one", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["done", "hi"] });
    await addInboxEvent(host.harness, project, event("e1", "bug"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    const offered = async (id: ConversationId) =>
      (await (await host.harness.conversation(id, context))!.agent(context)).tools.map((tool) => tool.name);
    expect(await offered(task!.conversationId!)).toContain("wake_me_at");
    const chat = await startChat(await connectTo(defer, host), "hello");
    expect(await offered(chat)).not.toContain("wake_me_at");
  });
});
