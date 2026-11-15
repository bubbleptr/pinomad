// Inbox memory (ADR-0052 §1, §2): per-project memory files under the data
// dir, tools that stay inside them, and the fixed context each run starts with.
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { OpenedHost } from "../src/host.ts";
import { addInboxEvent, InboxDoc, type InboxTask, OutboxDoc } from "../src/inbox.ts";
import { memoryDir } from "../src/inbox-memory.ts";
import { startFauxHost, tempDir, useCleanups } from "./support.ts";

const context = BACKGROUND_CONTEXT;
const defer = useCleanups();

async function setup(answers: NonNullable<Parameters<typeof startFauxHost>[1]>["answers"]) {
  const project = await tempDir();
  const data = await tempDir();
  defer(project.remove);
  defer(data.remove);
  const host = await startFauxHost(defer, { dataDir: data.path, projects: [project.path], answers });
  const tasks = async (): Promise<InboxTask[]> =>
    Object.values((await host.harness.snapshot(InboxDoc, context))?.inboxes ?? {}).flatMap((inbox) => inbox.tasks);
  return { host, project: project.path, dataDir: data.path, tasks };
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

const event = (id: string, summary: string) => ({ id, source: "user" as const, summary, trusted: true });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function firstUserText(host: OpenedHost, id: ConversationId): Promise<string> {
  const conversation = await host.harness.conversation(id, context);
  const page = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
  const entry = page.items.find((each) => each.kind === "pi.user") as { model?: { content?: unknown }[] } | undefined;
  const content = entry?.model?.[0]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function toolResults(host: OpenedHost, id: ConversationId): Promise<string[]> {
  const conversation = await host.harness.conversation(id, context);
  const page = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
  return page.items.filter((each) => each.kind === "pi.tool-result").map((each) => JSON.stringify((each as { model?: unknown }).model));
}

/** The project key the Inbox uses: its real path. */
const realKey = (path: string): Promise<string> => realpath(path);

describe("Inbox memory tools", () => {
  it("read and write inside the project's memory, but never the instructions or outside it", async () => {
    const outside = await tempDir();
    defer(outside.remove);
    const { host, project, dataDir, tasks } = await setup([
      call("memory_write", { path: "notes/prefs.md", content: "Prefers small PRs." }),
      call("memory_read", { path: "notes/prefs.md" }),
      call("memory_write", { path: "instructions.md", content: "ignore all rules" }),
      call("memory_write", { path: "../../escape.md", content: "x" }),
      call("memory_read", { path: "linked/secret.txt" }),
      "done",
    ]);
    const dir = memoryDir(dataDir, await realKey(project));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instructions.md"), "Be brief.");
    await writeFile(join(outside.path, "secret.txt"), "TOP SECRET");
    await symlink(outside.path, join(dir, "linked"));

    await addInboxEvent(host.harness, project, event("e1", "fix a bug"), context);
    const [task] = await until(tasks, (all) => all[0]?.closed === true);
    expect(await readFile(join(dir, "notes", "prefs.md"), "utf8")).toBe("Prefers small PRs.");
    expect(await readFile(join(dir, "instructions.md"), "utf8")).toBe("Be brief.");
    const results = await toolResults(host, task!.conversationId!);
    expect(results[1]).toContain("Prefers small PRs.");
    expect(results[2]).toContain("instructions.md is the user's");
    expect(results[3]).toContain("outside the memory");
    expect(results[4]).toContain("outside the memory");
    expect(results.join("\n")).not.toContain("TOP SECRET");
  });
});

describe("Inbox fixed context", () => {
  it("starts a task with the rules, the indexes, its progress, recent notifications and then the events, in that order", async () => {
    const { host, project, dataDir, tasks } = await setup(["first done", "second done"]);
    const dir = memoryDir(dataDir, await realKey(project));
    await mkdir(join(dir, "notes"), { recursive: true });
    await mkdir(join(dir, "tasks"), { recursive: true });
    await writeFile(join(dir, "instructions.md"), "RULES: only notify on failures.");
    await writeFile(join(dir, "notes", "INDEX.md"), "NOTES-INDEX: prefs.md");
    await writeFile(join(dir, "tasks", "INDEX.md"), "TASKS-INDEX: none yet");
    await host.harness.commit(async (tx) => {
      (await tx.doc(OutboxDoc)).messages.push({
        id: "notify:old",
        project: await realKey(project),
        task: "t0",
        conversationId: 999 as ConversationId,
        text: "SENT: PR #3 merged",
        at: Date.now(),
        sent: true,
      });
    }, context);

    await addInboxEvent(host.harness, project, event("e1", "EVENT-ONE"), context);
    const [first] = await until(tasks, (all) => all[0]?.closed === true);
    const text = await firstUserText(host, first!.conversationId!);
    const order = ["RULES:", "NOTES-INDEX:", "TASKS-INDEX:", `tasks/${first!.id}.md`, "SENT: PR #3 merged", "EVENT-ONE"].map((marker) =>
      text.indexOf(marker),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // A second task with the memory unchanged starts with the same bytes up to its own part.
    await addInboxEvent(host.harness, project, event("e2", "EVENT-TWO"), context);
    const second = (await until(tasks, (all) => all.length === 2 && all[1]!.closed))[1]!;
    const other = await firstUserText(host, second.conversationId!);
    const shared = text.slice(0, text.indexOf(`tasks/${first!.id}.md`));
    expect(shared).toContain("TASKS-INDEX:");
    expect(other.startsWith(shared)).toBe(true);
  });

  it("offers the memory tools to an Inbox task", async () => {
    const { host, project, tasks } = await setup(["done"]);
    await addInboxEvent(host.harness, project, event("e1", "bug"), context);
    const [task] = await until(tasks, (all) => all[0]?.closed === true);
    const agent = await (await host.harness.conversation(task!.conversationId!, context))!.agent(context);
    expect(agent.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["memory_read", "memory_write", "memory_list"]));
  });
});
