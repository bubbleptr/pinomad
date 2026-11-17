// The Inbox over the gateway (5.38, ADR-0051 §2, §6, §11): the `inbox` host
// stream and the calls the Tasks page and the intake use, through a real client.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { INBOX_RULES_MAX_BYTES, type HostInbox, type ProjectInbox } from "@pinomad/protocol/inbox.ts";
import { question } from "../src/extensions/question.ts";
import { addInboxEvent, addTimer, InboxDoc, TimerDoc } from "../src/inbox.ts";
import { memoryDir } from "../src/inbox-memory.ts";
import { IndexDoc } from "../src/organization.ts";
import { connectTo, LONG_ANSWER, startChat, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const context = BACKGROUND_CONTEXT;
const exec = promisify(execFile);
const defer = useCleanups();

async function project(): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  return dir.path;
}

const event = (id: string, summary: string, thread?: string) => ({
  id,
  source: "user" as const,
  summary,
  trusted: true,
  ...(thread === undefined ? {} : { thread }),
});

/** A host with one project, a client on it, and the project's key as the host stores it. */
async function inboxHost(options: Omit<NonNullable<Parameters<typeof startFauxHost>[1]>, "dataDir" | "projects"> & { git?: boolean } = {}) {
  const { git, ...hostOptions } = options;
  const path = await project();
  if (git === true) {
    await exec("git", ["init", "-q", "-b", "trunk"], { cwd: path });
    await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: path });
    await exec("git", ["branch", "release"], { cwd: path });
  }
  const dataDir = await tempDir();
  defer(dataDir.remove);
  const host = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], ...hostOptions });
  const key = (await host.harness.snapshot(IndexDoc, context))!.projects[0]!.path;
  const client = await connectTo(defer, host);
  const inboxOf = (view: { inbox: HostInbox | null }): ProjectInbox | undefined => view.inbox?.inboxes.find((each) => each.project === key);
  const until = async (test: (inbox: ProjectInbox) => boolean): Promise<ProjectInbox> => {
    await waitForView(client.view, (view) => {
      const inbox = inboxOf(view);
      return inbox !== undefined && test(inbox);
    });
    return inboxOf(client.view.current())!;
  };
  return { host, key, client, dataDir: dataDir.path, until };
}

describe("the inbox stream", () => {
  it("has every registered project, empty until something arrives", async () => {
    const { until } = await inboxHost();
    const inbox = await until(() => true);
    expect(inbox).toMatchObject({ tasks: [], threads: {}, rules: "" });
    expect(inbox.intake).toBeUndefined();
  });

  it("carries tasks with their events, threads, follow-ups and the intake", async () => {
    const { host, key, client, until } = await inboxHost({ answers: ["fixed", "hello"] });
    await addInboxEvent(host.harness, key, event("e1", "login fails", "github:acme/web#1"), context);
    const done = await until((inbox) => inbox.tasks[0]?.closed === true);
    const [task] = done.tasks;
    expect(task).toMatchObject({ title: "login fails", closed: true });
    expect(task!.conversationId).toBeGreaterThan(0);
    expect(task!.inFlight).toBeUndefined();
    expect(task!.events).toEqual([
      { id: "e1", source: "user", thread: "github:acme/web#1", summary: "login fails", trusted: true, receivedAt: expect.any(Number), handled: true },
    ]);
    expect(done.threads).toEqual({ "github:acme/web#1": task!.id });

    const due = Date.now() + 3_600_000;
    await addTimer(host.harness, key, { id: "check-ci", due, note: "check CI", task: task!.id }, context);
    const withFollowUp = await until((inbox) => inbox.followUps.some((each) => each.id === "check-ci"));
    expect(withFollowUp.followUps.find((each) => each.id === "check-ci")).toEqual({ id: "check-ci", due, note: "check CI", task: task!.id });
    // The daily tidy-up is listed too, marked so the client offers no cancel.
    expect(withFollowUp.followUps.find((each) => each.kind === "tidy")).toMatchObject({ every: 24 * 60 * 60_000 });

    const intake = await client.controller.sendToIntake(key, "hi");
    expect((await until((inbox) => inbox.intake !== undefined)).intake).toBe(intake);
  });
});

describe("setInboxRules", () => {
  it("writes instructions.md and republishes the rules", async () => {
    const { key, client, dataDir, until } = await inboxHost();
    await until(() => true);
    await client.controller.setInboxRules(key, "Only notify me about failures.");
    expect((await until((inbox) => inbox.rules !== "")).rules).toBe("Only notify me about failures.");
    expect(await readFile(join(memoryDir(dataDir, key), "instructions.md"), "utf8")).toBe("Only notify me about failures.");
    await client.controller.setInboxRules(key, "");
    await until((inbox) => inbox.rules === "");
  });

  it("refuses rules over the cap and projects the host does not have", async () => {
    const { key, client } = await inboxHost();
    await expect(client.controller.setInboxRules(key, "é".repeat(INBOX_RULES_MAX_BYTES / 2 + 1))).rejects.toThrow(/too long/);
    await expect(client.controller.setInboxRules("/no/such/project", "x")).rejects.toThrow(/Unknown project/);
  });
});

describe("cancelFollowUp", () => {
  it("drops a follow-up, and refuses the tidy-up and unknown ids", async () => {
    const { host, key, client, until } = await inboxHost({ answers: ["ok"] });
    // The tidy-up timer comes with the project's first event.
    await addInboxEvent(host.harness, key, event("e1", "a task"), context);
    await addTimer(host.harness, key, { id: "later", due: Date.now() + 3_600_000, note: "later" }, context);
    const before = await until((inbox) => inbox.followUps.some((each) => each.id === "later") && inbox.followUps.some((each) => each.kind === "tidy"));
    await client.controller.cancelFollowUp("later");
    await until((inbox) => !inbox.followUps.some((each) => each.id === "later"));
    expect((await host.harness.snapshot(TimerDoc, context))!.timers.find((timer) => timer.id === "later")!.done).toBe(true);
    const tidy = before.followUps.find((each) => each.kind === "tidy")!;
    await expect(client.controller.cancelFollowUp(tidy.id)).rejects.toThrow(/tidy-up/);
    await expect(client.controller.cancelFollowUp("later")).rejects.toThrow(/No follow-up/);
  });
});

describe("skipInboxTask", () => {
  it("closes a pending task as skipped; a later event on its thread reopens it", async () => {
    const { host, key, client, until } = await inboxHost({ answers: [LONG_ANSWER, "second"], tokensPerSecond: 20 });
    await addInboxEvent(host.harness, key, event("e1", "slow one"), context);
    await addInboxEvent(host.harness, key, event("e2", "skip me", "github:acme/web#2"), context);
    const running = await until((inbox) => inbox.tasks.length === 2 && inbox.tasks[0]!.inFlight === true);
    const [first, second] = running.tasks;
    // The worker has a batch of the first out: it cannot be skipped.
    await expect(client.controller.skipInboxTask(key, first!.id)).rejects.toThrow(/running/);
    await client.controller.skipInboxTask(key, second!.id);
    const skipped = await until((inbox) => inbox.tasks[1]!.skipped === true);
    expect(skipped.tasks[1]).toMatchObject({ closed: true, skipped: true, events: [{ handled: true }] });
    // The worker moves on without running it.
    await until((inbox) => inbox.tasks[0]!.closed);
    expect(inboxTask(await host.harness.snapshot(InboxDoc, context), key, second!.id)?.conversationId).toBeUndefined();

    await addInboxEvent(host.harness, key, event("e3", "it came back", "github:acme/web#2"), context);
    const reopened = await until((inbox) => inbox.tasks[1]!.events.length === 2 && inbox.tasks[1]!.closed);
    expect(reopened.tasks[1]!.skipped).toBeUndefined();
    expect(reopened.tasks[1]!.conversationId).toBeGreaterThan(0);
  });

  it("refuses an unknown task", async () => {
    const { key, client } = await inboxHost();
    await expect(client.controller.skipInboxTask(key, "nope")).rejects.toThrow(/No task/);
  });
});

const inboxTask = (doc: { inboxes: Record<string, { tasks: { id: string; conversationId?: number }[] }> } | undefined, key: string, id: string) =>
  doc?.inboxes[key]?.tasks.find((task) => task.id === id);

describe("the Inbox's base branch (5.41, #846)", () => {
  it("shows a git project's default branch, and setInboxBaseBranch picks another or goes back", async () => {
    const { host, key, client, until } = await inboxHost({ git: true });
    expect((await until((inbox) => inbox.baseBranch !== undefined)).baseBranch).toBe("trunk");
    // Shown, not stored: an Inbox entry would start a daily tidy-up for a project that never used it.
    expect((await host.harness.snapshot(InboxDoc, context))?.inboxes[key]).toBeUndefined();
    expect((await host.harness.snapshot(TimerDoc, context))?.timers.some((timer) => timer.project === key)).toBe(false);
    await client.controller.setInboxBaseBranch(key, "release");
    await until((inbox) => inbox.baseBranch === "release");
    await expect(client.controller.setInboxBaseBranch(key, "nope")).rejects.toThrow(/"nope" does not exist/);
    await client.controller.setInboxBaseBranch(key, null);
    await until((inbox) => inbox.baseBranch === "trunk");
  });

  it("keeps the chosen branch when going back to the default finds none", async () => {
    const { key, client, until } = await inboxHost({ git: true });
    await until((inbox) => inbox.baseBranch !== undefined);
    await client.controller.setInboxBaseBranch(key, "release");
    await until((inbox) => inbox.baseBranch === "release");
    // No origin/HEAD, main or master, and a detached HEAD: there is no default to go back to.
    await exec("git", ["checkout", "-q", "--detach"], { cwd: key });
    await exec("git", ["branch", "-q", "-D", "trunk"], { cwd: key });
    await expect(client.controller.setInboxBaseBranch(key, null)).rejects.toThrow(/No branch/);
    expect((await until(() => true)).baseBranch).toBe("release");
  });

  it("has none for a project that is not a Git repository, and refuses to set one", async () => {
    const { key, client, until } = await inboxHost();
    expect((await until(() => true)).baseBranch).toBeUndefined();
    await expect(client.controller.setInboxBaseBranch(key, "main")).rejects.toThrow(/not a Git repository/);
  });
});

describe("the temporarily disabled Inbox mode", () => {
  it("keeps new events pending, refuses Inbox writes, and leaves coding available", async () => {
    const { host, key, client, until } = await inboxHost({ inbox: false, answers: ["coding done"] });
    await addInboxEvent(host.harness, key, event("pending", "do not run"), context);
    const pending = await until((inbox) => inbox.tasks.length === 1);
    expect(pending.tasks[0]!.conversationId).toBeUndefined();

    const coding = await startChat(client, "ordinary coding");
    await (await host.harness.conversation(coding, context))!.waitForIdle(context);
    expect((await until(() => true)).tasks[0]!.conversationId).toBeUndefined();
    await expect(client.controller.sendToIntake(key, "new task")).rejects.toThrow(/disabled/);
    await expect(client.controller.setInboxRules(key, "rules")).rejects.toThrow(/disabled/);
    await client.controller.updateSettings({ inboxQuietHours: { start: 1, end: 2 } });
    expect(client.view.current().notices.at(-1)?.message).toMatch(/temporarily disabled/);
    expect(host.settings.value.inboxQuietHours).toBeNull();
    await client.controller.updateSettings({ steeringMode: "all" });
    expect(host.settings.value.steeringMode).toBe("all");
    await expect(client.controller.skipInboxTask(key, pending.tasks[0]!.id)).rejects.toThrow(/disabled/);
    await expect(
      client.controller.addInboxSource(key, "schedule", true, {
        kind: "schedule",
        note: "check",
        schedule: { kind: "daily", time: "09:00", timeZone: "UTC" },
      }),
    ).rejects.toThrow(/disabled/);

    const url = new URL(`/inbox/disabled/events`, host.url.replace(/^ws/, "http"));
    const response = await fetch(url, { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
  });

  it("refuses ordinary conversation calls that would restart an old task", async () => {
    const path = await project();
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const first = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], answers: ["done", LONG_ANSWER], tokensPerSecond: 20 });
    await addInboxEvent(first.harness, path, event("done", "already done"), context);
    const firstClient = await connectTo(defer, first);
    await waitForView(firstClient.view, (view) => view.inbox?.inboxes[0]?.tasks[0]?.closed === true);
    const taskId = Object.values((await first.harness.snapshot(InboxDoc, context))!.inboxes)[0]!.tasks[0]!.conversationId!;
    await firstClient.controller.switchConversation(taskId);
    await firstClient.controller.fork(String(firstClient.view.current().conversation!.entries.at(-1)!.id), LONG_ANSWER);
    const forkId = firstClient.view.current().conversation!.conversation.id;
    await first.close();

    const disabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], inbox: false });
    const client = await connectTo(defer, disabled);
    await client.controller.switchConversation(taskId);
    await client.controller.submit("ordinary submit must not run", "followUp", { target: taskId, requestId: "disabled-submit" });
    await waitForView(
      client.view,
      (view) =>
        view.submissions?.some(
          (submission) => submission.requestId === "disabled-submit" && submission.phase === "failed" && submission.error?.includes("disabled") === true,
        ) === true,
    );
    await client.controller.compact(undefined);
    expect(client.view.current().notices.at(-1)?.message).toMatch(/temporarily disabled/);
    const entries = await (await disabled.harness.conversation(taskId, context))!.entries({ order: "ascending" }, 1000, undefined, context);
    expect(JSON.stringify(entries.items)).not.toContain("ordinary submit must not run");
    const recoveredFork = await (await disabled.harness.conversation(forkId, context))!.entries({ order: "ascending" }, 1000, undefined, context);
    const forkAnswers = recoveredFork.items.filter((entry) => entry.kind === "pi.assistant");
    expect(JSON.stringify(forkAnswers)).not.toContain(LONG_ANSWER);

    await client.controller.fork(String(entries.items[0]!.id), "new fork must not run");
    expect(client.view.current().notices.at(-1)?.message).toMatch(/temporarily disabled/);
    expect(client.view.current().conversation!.conversation.id).toBe(taskId);
  });

  it("allows an already-resolved answer to be retried without restarting work", async () => {
    const path = await project();
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const asks = fauxAssistantMessage(
      fauxToolCall("ask_user_question", { questions: [{ header: "Scope", question: "Desktop too?", options: [{ label: "Yes" }, { label: "No" }] }] }),
      { stopReason: "toolUse" },
    );
    const first = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], extensions: [question], answers: [asks, "done"] });
    await addInboxEvent(first.harness, path, event("ask", "layout bug"), context);
    const firstClient = await connectTo(defer, first);
    await waitForView(firstClient.view, (view) => (view.inbox?.inboxes[0]?.tasks[0]?.questions?.length ?? 0) > 0);
    const task = firstClient.view.current().inbox!.inboxes[0]!.tasks[0]!;
    const pending = task.questions![0]!;
    await firstClient.controller.answer(pending.kind, pending.request.id, [{ selected: ["Yes"] }], task.conversationId);
    await first.close();

    const disabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], inbox: false });
    const client = await connectTo(defer, disabled);
    await client.controller.answer(pending.kind, pending.request.id, [{ selected: ["Yes"] }], task.conversationId);
    expect(client.view.current().notices.some((notice) => notice.message.includes("temporarily disabled"))).toBe(false);
  });

  it("does not resume an interrupted task or take its queued successor", async () => {
    const path = await project();
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const first = await startFauxHost(defer, {
      dataDir: dataDir.path,
      projects: [path],
      answers: [LONG_ANSWER, "must not run"],
      tokensPerSecond: 20,
    });
    await addInboxEvent(first.harness, path, event("running", "interrupted"), context);
    await addInboxEvent(first.harness, path, event("queued", "still queued"), context);
    const key = Object.entries((await first.harness.snapshot(InboxDoc, context))!.inboxes).find(([, inbox]) => inbox.tasks.length === 2)![0];
    const firstClient = await connectTo(defer, first);
    await waitForView(firstClient.view, (view) => view.inbox?.inboxes[0]?.tasks[0]?.conversationId !== undefined);
    const runningId = (await first.harness.snapshot(InboxDoc, context))!.inboxes[key]!.tasks[0]!.conversationId!;
    // The first-run crash window: the conversation exists, but the worker has
    // not recorded its id yet. The batch and index request ids still agree.
    await first.harness.commit(async (tx) => {
      const task = (await tx.doc(InboxDoc)).inboxes[key]!.tasks[0]!;
      task.conversationId = undefined;
      expect(task.batch?.requestId).toBe((await tx.doc(IndexDoc)).conversations.find((entry) => entry.id === runningId)?.requestId);
    }, context);
    await first.close();

    const disabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], inbox: false });
    const client = await connectTo(defer, disabled);
    expect(client.view.current().inbox?.inboxes[0]?.tasks[0]?.conversationId).toBe(runningId);
    await client.controller.submit("must not restart either", "followUp", { target: runningId, requestId: "disabled-window" });
    await waitForView(
      client.view,
      (view) =>
        view.submissions?.some(
          (submission) => submission.requestId === "disabled-window" && submission.phase === "failed" && submission.error?.includes("disabled") === true,
        ) === true,
    );
    await (await disabled.harness.conversation(runningId, context))!.waitForIdle(context);
    const conversation = await disabled.harness.conversation(runningId, context);
    const entries = await conversation!.entries({ order: "ascending" }, 1000, undefined, context);
    expect(JSON.stringify(entries.items)).not.toContain(LONG_ANSWER);
    expect(JSON.stringify(entries.items)).not.toContain("must not restart either");
    const inboxes = (await disabled.harness.snapshot(InboxDoc, context))!.inboxes[key]!;
    expect(inboxes.tasks).toHaveLength(2);
    expect(inboxes.tasks[1]!.conversationId).toBeUndefined();
    expect(inboxes.tasks[1]!.events[0]!.handled).toBe(false);
  });
});

describe("re-enabling the Inbox", () => {
  it("retries a batch aborted by the dormant host instead of closing it", async () => {
    const path = await project();
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const first = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], answers: [LONG_ANSWER], tokensPerSecond: 20 });
    await addInboxEvent(first.harness, path, event("resume", "resume this task"), context);
    const firstClient = await connectTo(defer, first);
    await waitForView(firstClient.view, (view) => view.inbox?.inboxes[0]?.tasks[0]?.conversationId !== undefined);
    const taskId = Object.values((await first.harness.snapshot(InboxDoc, context))!.inboxes)[0]!.tasks[0]!.conversationId!;
    await first.close();

    const disabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], inbox: false });
    await (await disabled.harness.conversation(taskId, context))!.waitForIdle(context);
    await disabled.close();

    const enabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], answers: ["resumed done"] });
    const client = await connectTo(defer, enabled);
    await waitForView(client.view, (view) => view.inbox?.inboxes[0]?.tasks[0]?.closed === true);
    const entries = await (await enabled.harness.conversation(taskId, context))!.entries({ order: "ascending" }, 1000, undefined, context);
    const answers = entries.items.filter((entry) => entry.kind === "pi.assistant");
    expect(JSON.stringify(answers)).toContain("resumed done");
  });
});

describe("a task already stopped before the dormant host", () => {
  it("does not mark a user's earlier Stop for a later resume", async () => {
    const path = await project();
    const dataDir = await tempDir();
    defer(dataDir.remove);
    const first = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], answers: [LONG_ANSWER], tokensPerSecond: 20 });
    await addInboxEvent(first.harness, path, event("stop", "stop this task"), context);
    const firstClient = await connectTo(defer, first);
    await waitForView(firstClient.view, (view) => view.inbox?.inboxes[0]?.tasks[0]?.conversationId !== undefined);
    const taskId = Object.values((await first.harness.snapshot(InboxDoc, context))!.inboxes)[0]!.tasks[0]!.conversationId!;
    const inspection = await first.harness.inspect(context);
    const running = inspection.tasks.find((task) => task.record.conversationId === taskId && task.record.owner === undefined)!;
    await first.harness.abortTask(running.record.id, context);
    await first.close();

    const disabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], inbox: false });
    const batch = Object.values((await disabled.harness.snapshot(InboxDoc, context))!.inboxes)[0]!.tasks[0]!.batch;
    expect(batch).toMatchObject({ requestId: expect.any(String), admitted: true });
    expect(batch!.paused).toBeUndefined();
    await disabled.close();

    const enabled = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], answers: ["must not resume"] });
    const client = await connectTo(defer, enabled);
    await waitForView(client.view, (view) => view.inbox?.inboxes[0]?.tasks[0]?.closed === true);
    const entries = await (await enabled.harness.conversation(taskId, context))!.entries({ order: "ascending" }, 1000, undefined, context);
    expect(JSON.stringify(entries.items.filter((entry) => entry.kind === "pi.assistant"))).not.toContain("must not resume");
  });
});

describe("a task's questions in the stream (5.41, #846)", () => {
  it("carries the questions a task waits on, and drops them once answered there", async () => {
    const asks = fauxAssistantMessage(
      fauxToolCall("ask_user_question", { questions: [{ header: "Scope", question: "Desktop too?", options: [{ label: "Yes" }, { label: "No" }] }] }),
      { stopReason: "toolUse" },
    );
    const { host, key, client, until } = await inboxHost({ git: true, extensions: [question], answers: [asks, "done"] });
    await addInboxEvent(host.harness, key, event("e1", "layout bug"), context);
    const waiting = await until((inbox) => (inbox.tasks[0]?.questions?.length ?? 0) > 0);
    const [task] = waiting.tasks;
    const [pending] = task!.questions!;
    expect(pending!.request.questions[0]!.question).toBe("Desktop too?");
    await client.controller.answer(pending!.kind, pending!.request.id, [{ selected: ["Yes"] }], task!.conversationId);
    const answered = await until((inbox) => inbox.tasks[0]?.questions === undefined);
    expect(answered.tasks[0]!.questions).toBeUndefined();
    await until((inbox) => inbox.tasks[0]?.closed === true);
  });
});
