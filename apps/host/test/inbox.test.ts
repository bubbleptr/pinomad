import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type FauxResponseStep, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationDocToken, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { QuestionState } from "@pinomad/protocol/presentation.ts";
import { coding } from "../src/extensions/coding.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import { addInboxEvent, addTimer, InboxDoc, type InboxTask, TimerDoc } from "../src/inbox.ts";
import { IndexDoc } from "../src/organization.ts";

import { INBOX_BATCH_ENTRY, isUserMessageEntry } from "@pinomad/protocol/inbox.ts";
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
    .filter((entry) => isUserMessageEntry(entry.kind))
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

  it("tags each batch message with its task and events, the first one and a later one alike", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["fixed", "looked at CI"] });
    await addInboxEvent(host.harness, project, { ...event("issue-1", "issue opened"), thread: "github:acme/web#1" }, context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    await addInboxEvent(host.harness, project, { ...event("ci-1", "CI failed"), thread: "github:acme/web#1" }, context);
    await until(() => tasksOf(host, project), (tasks) => tasks[0]!.events.length === 2 && tasks[0]!.closed);
    const conversation = await host.harness.conversation(task!.conversationId!, context);
    const page = await conversation!.entries({ order: "ascending" }, 1000, undefined, context);
    const batches = page.items.filter((entry) => entry.kind === INBOX_BATCH_ENTRY).map((entry) => entry.data);
    expect(batches).toEqual([
      { task: task!.id, eventIds: ["issue-1"] },
      { task: task!.id, eventIds: ["ci-1"] },
    ]);
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
  // The timers these tests set: every Inbox also gets its own tidy-up timer.
  const timersOf = async (host: OpenedHost) =>
    ((await host.harness.snapshot(TimerDoc, context))?.timers ?? []).filter((timer) => timer.kind !== "tidy");

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

  it("keeps one timer per wake_me_at call even when two tasks' calls share a provider call id", async () => {
    const project = await gitProject();
    const wake = (note: string) =>
      fauxAssistantMessage(fauxToolCall("wake_me_at", { in_minutes: 60, note }, { id: "call_0" }), { stopReason: "toolUse" });
    const host = await startFauxHost(defer, { projects: [project], answers: [wake("first"), "ok", wake("second"), "ok"] });
    await addInboxEvent(host.harness, project, event("e1", "one"), context);
    await addInboxEvent(host.harness, project, event("e2", "two"), context);
    const tasks = await until(() => tasksOf(host, project), (tasks) => tasks.length === 2 && tasks.every((task) => task.closed));
    const timers = await timersOf(host);
    expect(timers.map((timer) => [timer.task, timer.note])).toEqual([
      [tasks[0]!.id, "first"],
      [tasks[1]!.id, "second"],
    ]);
  });

  it("wakes right away for a wake_me_at time that has already passed", async () => {
    const project = await plainProject();
    const at = new Date(Date.now() - 60_000).toISOString();
    const wake = fauxAssistantMessage(fauxToolCall("wake_me_at", { at, note: "late check" }), { stopReason: "toolUse" });
    const host = await startFauxHost(defer, { projects: [project], answers: [wake, "later", "checked"] });
    await addInboxEvent(host.harness, project, event("e1", "bug"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.events.length === 2 && tasks[0]!.closed);
    expect(task!.events[1]).toMatchObject({ source: "followUp", summary: "late check" });
  });

  it("offers the Inbox tools to an Inbox task's conversation and not to an ordinary one", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["done", "hi"] });
    await addInboxEvent(host.harness, project, event("e1", "bug"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    const offered = async (id: ConversationId) =>
      (await (await host.harness.conversation(id, context))!.agent(context)).tools.map((tool) => tool.name);
    expect(await offered(task!.conversationId!)).toEqual(expect.arrayContaining(["wake_me_at", "notify", "inbox_follow"]));
    const chat = await startChat(await connectTo(defer, host), "hello");
    const ordinary = await offered(chat);
    for (const name of ["wake_me_at", "notify", "inbox_follow"]) expect(ordinary).not.toContain(name);
  });
});

describe("Inbox models", () => {
  const fauxModels = [
    { id: "faux-1", name: "Faux One" },
    { id: "faux-2", name: "Faux Two" },
    { id: "faux-3", name: "Faux Three" },
  ];
  const ref = (modelId: string) => ({ provider: "faux", modelId });
  const modelOf = async (host: OpenedHost, id: ConversationId) =>
    (await (await host.harness.conversation(id, context))!.agent(context)).model;

  it("starts the intake on the intake model and tasks on the worker model", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], fauxModels, answers: ["noted", "fixed"] });
    await host.settings.update({ defaultModel: ref("faux-1"), inboxIntakeModel: ref("faux-2"), inboxWorkerModel: ref("faux-3") });
    const intake = await host.inbox.sendToIntake(project, "login is broken", "r1", context);
    await addInboxEvent(host.harness, project, event("e1", "bug one"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.conversationId !== undefined);
    expect(await modelOf(host, intake)).toEqual(ref("faux-2"));
    expect(await modelOf(host, task!.conversationId!)).toEqual(ref("faux-3"));
  });

  it("falls back to the default model when neither is set", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], fauxModels, answers: ["noted", "fixed"] });
    await host.settings.update({ defaultModel: ref("faux-2") });
    const intake = await host.inbox.sendToIntake(project, "login is broken", "r1", context);
    await addInboxEvent(host.harness, project, event("e1", "bug one"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.conversationId !== undefined);
    expect(await modelOf(host, intake)).toEqual(ref("faux-2"));
    expect(await modelOf(host, task!.conversationId!)).toEqual(ref("faux-2"));
  });
});

describe("inbox_follow", () => {
  const follow = (thread: string) => fauxAssistantMessage(fauxToolCall("inbox_follow", { thread }), { stopReason: "toolUse" });

  it("routes a later event on a thread the task followed back to that task", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: [follow("github:acme/web#77"), "opened the PR", "CI fixed"] });
    await addInboxEvent(host.harness, project, event("e1", "fix the login bug"), context);
    await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    await addInboxEvent(host.harness, project, { ...event("pr-77-ci", "CI failed on the PR"), thread: "github:acme/web#77", trusted: false }, context);
    const tasks = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.events.length === 2 && tasks[0]!.closed);
    expect(tasks).toHaveLength(1);
  });

  it("will not take over a thread another task follows", async () => {
    const project = await gitProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["on it", follow("github:acme/web#1"), "tried"] });
    await addInboxEvent(host.harness, project, { ...event("issue-1", "issue 1 opened"), thread: "github:acme/web#1" }, context);
    await addInboxEvent(host.harness, project, event("e2", "something else"), context);
    const tasks = await until(() => tasksOf(host, project), (tasks) => tasks.length === 2 && tasks.every((task) => task.closed));
    const doc = await host.harness.snapshot(InboxDoc, context);
    const threads = Object.values(doc!.inboxes)[0]!.threads;
    expect(threads["github:acme/web#1"]).toBe(tasks[0]!.id);
  });
});

describe("intake conversation", () => {
  const submit = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall("inbox_submit", args), { stopReason: "toolUse" });
  const agentOf = async (host: OpenedHost, id: ConversationId) => (await host.harness.conversation(id, context))!.agent(context);
  /** The intake section as the next request would render it. */
  const intakePrompt = async (host: OpenedHost, id: ConversationId) => {
    const section = (await agentOf(host, id)).sections.find((each) => each.key === "inbox_intake");
    return await section?.render({ conversationId: id, read: host.harness } as never, context);
  };
  const intakeOf = async (host: OpenedHost) =>
    Object.values((await host.harness.snapshot(InboxDoc, context))?.inboxes ?? {})[0]?.intake;

  it("opens one intake conversation per project, with only read-only tools, questions and inbox_submit", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], extensions: [coding, question], answers: ["noted", "again"] });
    // Sent at once: the second must not open a second intake.
    const [first, second] = await Promise.all([
      host.inbox.sendToIntake(project, "two bugs: login fails, avatar blurry", "r1", context),
      host.inbox.sendToIntake(project, "also the footer", "r2", context),
    ]);
    expect(second).toBe(first);
    expect(await intakeOf(host)).toBe(first);
    await until(() => userTexts(host, first), (texts) => texts.length === 2);
    expect((await agentOf(host, first)).tools.map((tool) => tool.name).sort()).toEqual(["ask_user_question", "inbox_submit", "read"]);
  });

  it("puts what the user asked for into the Inbox as tasks the worker runs", async () => {
    const project = await gitProject();
    const host = await startFauxHost(defer, {
      projects: [project],
      answers: [submit({ title: "Login fails", detail: "Login fails on Safari after the redirect" }), "submitted", "fixed login"],
    });
    await host.inbox.sendToIntake(project, "login is broken on safari", "r1", context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(task).toMatchObject({ title: "Login fails" });
    expect(task!.events[0]).toMatchObject({ source: "user", trusted: true, summary: "Login fails on Safari after the redirect" });
    expect(task!.conversationId).not.toBe(await intakeOf(host));
  });

  it("marks a submission that quotes outside text as external", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, {
      projects: [project],
      answers: [submit({ title: "Issue 9", detail: "Issue #9 says: crash on start", external: true }), "submitted", "looked"],
    });
    await host.inbox.sendToIntake(project, "handle issue 9, here is its text", "r1", context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(task!.events[0]!.trusted).toBe(false);
  });

  it("adds to an existing task with mergeInto, and lists the tasks in its system prompt", async () => {
    const project = await plainProject();
    let taskId = "";
    const host = await startFauxHost(defer, {
      projects: [project],
      answers: [
        "fixed avatar",
        // Merges into the task the first event opened, known only once it ran.
        () => submit({ title: "Avatar", detail: "It is blurry on iPad too", mergeInto: taskId }),
        "added",
        "fixed iPad too",
      ],
    });
    await addInboxEvent(host.harness, project, event("e1", "avatar is blurry"), context);
    const [first] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    taskId = first!.id;
    const intake = await host.inbox.sendToIntake(project, "the avatar is blurry on iPad too", "r1", context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.events.length === 2 && tasks[0]!.closed);
    expect(await tasksOf(host, project)).toHaveLength(1);
    expect(task!.events[1]!.summary).toBe("It is blurry on iPad too");
    const prompt = await intakePrompt(host, intake);
    expect(prompt).toContain(`${taskId} [done] avatar is blurry`);
    // A task's own conversation does not get the intake's prompt.
    expect(await intakePrompt(host, task!.conversationId!)).toBeUndefined();
  });

  it("refuses inbox_submit outside an intake conversation", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: [submit({ title: "x", detail: "y" }), "tried"] });
    await addInboxEvent(host.harness, project, event("e1", "a task"), context);
    await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(await tasksOf(host, project)).toHaveLength(1);
  });
  it("is the intake already when its first run starts", async () => {
    const project = await plainProject();
    let seen: ConversationId | undefined | "unread" = "unread";
    let host: OpenedHost | undefined;
    host = await startFauxHost(defer, {
      projects: [project],
      answers: [
        async () => {
          seen = await intakeOf(host!);
          return fauxAssistantMessage("hello");
        },
      ],
    });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    await until(async () => seen, (value) => value !== "unread");
    expect(seen).toBe(intake);
  });

  it("lists a task stopped on a question as waiting for the user", async () => {
    const project = await gitProject();
    const host = await startFauxHost(defer, { projects: [project], extensions: [question], answers: ["noted", asks(), "done"] });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    await addInboxEvent(host.harness, project, event("e1", "layout bug"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.waiting === true);
    expect(await intakePrompt(host, intake)).toContain(`${task!.id} [waiting for the user]`);
    await answerPending(host, task!.conversationId!);
    await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect((await tasksOf(host, project))[0]!.waiting).toBeUndefined();
  });
});

describe("Inbox base branch", () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })).stdout.trim();
  const headOf = (cwd: string) => git(cwd, "rev-parse", "HEAD");
  /** A git project left on a feature branch one commit ahead of `main`. */
  async function onFeatureBranch(): Promise<{ project: string; main: string }> {
    const project = await gitProject();
    const main = await headOf(project);
    await git(project, "switch", "-q", "-c", "feature");
    await git(project, "commit", "-q", "--allow-empty", "-m", "feature work");
    return { project, main };
  }
  const toolResults = async (host: OpenedHost, id: ConversationId): Promise<string[]> => {
    const page = await (await host.harness.conversation(id, context))!.entries({ order: "ascending" }, 1000, undefined, context);
    return page.items.filter((each) => each.kind === "pi.tool-result").map((each) => JSON.stringify((each as { model?: unknown }).model));
  };
  const cwdOf = async (host: OpenedHost, id: ConversationId) => (await host.harness.snapshot(AgentDoc, id, context))?.cwd;
  const inboxOf = async (host: OpenedHost) => Object.values((await host.harness.snapshot(InboxDoc, context))?.inboxes ?? {})[0];

  it("starts a task's worktree at the base branch, not at what the project directory has checked out", async () => {
    const { project, main } = await onFeatureBranch();
    const host = await startFauxHost(defer, { projects: [project], answers: ["done"] });
    await addInboxEvent(host.harness, project, event("e1", "bug"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.conversationId !== undefined);
    const checkout = (await host.harness.snapshot(IndexDoc, context))?.checkouts?.find((each) => each.conversationId === task!.conversationId);
    expect(checkout?.base).toBe(main);
    expect((await inboxOf(host))?.baseBranch).toBe("main");
  });

  it("fails a task whose base branch is gone and goes on", async () => {
    const project = await gitProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["second done"] });
    await host.harness.commit(async (tx) => {
      (await tx.doc(InboxDoc)).inboxes[(await tx.doc(IndexDoc)).projects[0]!.path] = { tasks: [], threads: {}, baseBranch: "gone" };
    }, context);
    await addInboxEvent(host.harness, project, event("e1", "bug"), context);
    const [task] = await until(() => tasksOf(host, project), (tasks) => tasks[0]?.closed === true);
    expect(task!.failed).toContain("gone");
  });

  it("gives the intake its own checkout of the base branch, moved to the branch's tip before each message", async () => {
    const { project, main } = await onFeatureBranch();
    const host = await startFauxHost(defer, { projects: [project], answers: ["noted", "again"] });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    const cwd = (await cwdOf(host, intake))!;
    expect(cwd).toContain("/worktrees/");
    // Made lazily by the run's environment, as every worktree is.
    await until(() => headOf(cwd).catch(() => undefined), (head) => head !== undefined);
    expect(await headOf(cwd)).toBe(main);

    // main moves on while the project directory stays on the feature branch.
    await git(project, "switch", "-q", "main");
    await git(project, "commit", "-q", "--allow-empty", "-m", "main moved");
    const moved = await headOf(project);
    await git(project, "switch", "-q", "feature");
    await host.inbox.sendToIntake(project, "and now?", "r2", context);
    expect(await headOf(cwd)).toBe(moved);
    const checkout = (await host.harness.snapshot(IndexDoc, context))?.checkouts?.find((each) => each.conversationId === intake);
    expect(checkout?.base).toBe(moved);
  });

  it("moves the intake to the base branch's tip for a message sent the ordinary way, as clients send all but the first", async () => {
    const { project } = await onFeatureBranch();
    const host = await startFauxHost(defer, { projects: [project], answers: ["noted", "again"] });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    const cwd = (await cwdOf(host, intake))!;
    await until(() => headOf(cwd).catch(() => undefined), (head) => head !== undefined);
    await git(project, "switch", "-q", "main");
    await git(project, "commit", "-q", "--allow-empty", "-m", "main moved");
    const moved = await headOf(project);
    await git(project, "switch", "-q", "feature");
    const client = await connectTo(defer, host);
    await client.controller.submit("and now?", "followUp", { target: intake });
    await until(() => userTexts(host, intake), (texts) => texts.length === 2);
    expect(await headOf(cwd)).toBe(moved);
  });

  it("resets the intake's files even when its record already names the new base", async () => {
    const { project } = await onFeatureBranch();
    const host = await startFauxHost(defer, { projects: [project], answers: ["noted", "again"] });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    const cwd = (await cwdOf(host, intake))!;
    await until(() => headOf(cwd).catch(() => undefined), (head) => head !== undefined);
    await git(project, "switch", "-q", "main");
    await git(project, "commit", "-q", "--allow-empty", "-m", "main moved");
    const moved = await headOf(project);
    await git(project, "switch", "-q", "feature");
    // As a reset that failed after the record moved leaves it.
    await host.harness.commit(async (tx) => {
      const record = (await tx.doc(IndexDoc)).checkouts!.find((each) => each.conversationId === intake)!;
      record.base = moved;
    }, context);
    await host.inbox.sendToIntake(project, "and now?", "r2", context);
    expect(await headOf(cwd)).toBe(moved);
  });

  it("moves an intake opened in the project directory into its own checkout, and its next run reads there", async () => {
    const { project } = await onFeatureBranch();
    // Only on main: the project directory, on the feature branch, lacks it.
    await git(project, "switch", "-q", "main");
    await writeFile(join(project, "on-main.txt"), "from main\n");
    await git(project, "add", "on-main.txt");
    await git(project, "commit", "-q", "-m", "main only");
    await git(project, "switch", "-q", "feature");
    const host = await startFauxHost(defer, {
      projects: [project],
      extensions: [coding, question],
      answers: ["noted", fauxAssistantMessage(fauxToolCall("read", { path: "on-main.txt" }), { stopReason: "toolUse" }), "read it"],
    });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    const first = (await cwdOf(host, intake))!;
    await until(() => headOf(first).catch(() => undefined), (head) => head !== undefined);
    await until(() => userTexts(host, intake), (texts) => texts.length === 1);
    // As an intake opened before #846 was: in the project directory, with no checkout record and no worktree.
    await git(project, "worktree", "remove", "--force", first);
    await host.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDoc);
      index.checkouts = (index.checkouts ?? []).filter((each) => each.conversationId !== intake);
      (await tx.doc(AgentDoc, intake)).cwd = index.projects[0]!.path;
    }, context);
    await host.inbox.sendToIntake(project, "read on-main.txt", "r2", context);
    const cwd = (await cwdOf(host, intake))!;
    expect(cwd).toContain("/worktrees/");
    const [result] = await until(() => toolResults(host, intake), (results) => results.length === 1);
    expect(result).toContain("from main");
  });

  it("keeps a non-git project's intake in the project directory", async () => {
    const project = await plainProject();
    const host = await startFauxHost(defer, { projects: [project], answers: ["noted"] });
    const intake = await host.inbox.sendToIntake(project, "hi", "r1", context);
    expect(await cwdOf(host, intake)).toBe((await host.harness.snapshot(IndexDoc, context))!.projects[0]!.path);
  });
});
