// The Inbox over the gateway (5.38, ADR-0051 §2, §6, §11): the `inbox` host
// stream and the calls the Tasks page and the intake use, through a real client.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { INBOX_RULES_MAX_BYTES, type HostInbox, type ProjectInbox } from "@pinomad/protocol/inbox.ts";
import { addInboxEvent, addTimer, InboxDoc, TimerDoc } from "../src/inbox.ts";
import { memoryDir } from "../src/inbox-memory.ts";
import { IndexDoc } from "../src/organization.ts";
import { connectTo, LONG_ANSWER, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const context = BACKGROUND_CONTEXT;
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
async function inboxHost(options: { answers?: string[]; tokensPerSecond?: number } = {}) {
  const path = await project();
  const dataDir = await tempDir();
  defer(dataDir.remove);
  const host = await startFauxHost(defer, { dataDir: dataDir.path, projects: [path], ...options });
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
