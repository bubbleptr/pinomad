import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationDocToken, ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { QuestionState } from "@pinomad/protocol/presentation.ts";
import { question } from "../src/extensions/question.ts";
import type { OpenedHost } from "../src/host.ts";
import { addInboxEvent, InboxDoc, type InboxTask } from "../src/inbox.ts";
import { LONG_ANSWER, startFauxHost, tempDir, useCleanups } from "./support.ts";

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
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await tasksOf(host, project))[1]!.conversationId).toBeUndefined();
    await answerPending(host, id);
    const done = await until(() => tasksOf(host, project), (tasks) => tasks.every((task) => task.closed));
    expect(done[1]!.conversationId).toBeDefined();
  });
});
