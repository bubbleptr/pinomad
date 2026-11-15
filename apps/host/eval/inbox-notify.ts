// Inbox message-volume eval (ADR-0052 §5): recorded events run through a real
// host and a real model; each run ends notifying, quietly, or asking, and is
// scored against the expected ending. Needs real model access, so it is not
// part of CI. Usage and credentials: docs/inbox-eval.md.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createCoding } from "../src/extensions/coding.ts";
import { question } from "../src/extensions/question.ts";
import { todo } from "../src/extensions/todo.ts";
import { openHost, type OpenedHost } from "../src/host.ts";
import { addInboxEvent, InboxDoc, type InboxEventSource, type InboxTask, OutboxDoc } from "../src/inbox.ts";
import { modelSummaries } from "../src/pi-setup.ts";

type Outcome = "notify" | "quiet" | "ask";
type Case = {
  readonly name: string;
  readonly expect: Outcome;
  readonly files?: Readonly<Record<string, string>>;
  readonly events: readonly { readonly source: InboxEventSource; readonly summary: string; readonly trusted: boolean }[];
};

const context = BACKGROUND_CONTEXT;
const exec = promisify(execFile);
const CASE_TIMEOUT_MS = 5 * 60_000;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "anthropic/claude-haiku-5-5" },
    auth: { type: "string" },
    budget: { type: "string", default: "5" },
    only: { type: "string" },
    "pass-score": { type: "string", default: "0.75" },
  },
});

const [provider, ...rest] = values.model!.split("/");
const modelId = rest.join("/");
const budget = Number(values.budget);
const cases = (JSON.parse(await readFile(join(dirname(new URL(import.meta.url).pathname), "inbox-notify-cases.json"), "utf8")) as Case[]).filter(
  (each) => values.only === undefined || each.name.includes(values.only),
);

const dataDir = await mkdtemp(join(tmpdir(), "pinomad-eval-"));
if (values.auth !== undefined) await copyFile(values.auth, join(dataDir, "auth.json"));
const runtime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: join(dataDir, "models.json") });
if (runtime.getModel(provider!, modelId) === undefined) throw new Error(`Unknown model ${values.model}`);

const projects: string[] = [];
for (const each of cases) {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-eval-project-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [path, text] of Object.entries(each.files ?? {})) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  projects.push(dir);
}

const host: OpenedHost = await openHost({
  dataDir,
  agentsHome: join(dataDir, "agents-home"),
  models: runtime,
  modelSummaries: () => modelSummaries(runtime),
  extensions: [createCoding(), question, todo],
  projects,
  port: 0,
  autoTitle: false,
  settingsFallback: {
    defaultModel: () => ({ provider: provider!, modelId }),
    defaultThinkingLevel: () => null,
    steeringMode: () => "one-at-a-time",
    followUpMode: () => "one-at-a-time",
  },
});

const taskOf = async (project: string): Promise<InboxTask | undefined> =>
  Object.entries((await host.harness.snapshot(InboxDoc, context))?.inboxes ?? {}).find(([key]) => key.endsWith(project.split("/").pop()!))?.[1]
    .tasks[0];

/** Cost of every model reply in a conversation, as the provider reported it, and whether one failed. */
async function repliesOf(id: ConversationId): Promise<{ cost: number; error?: string }> {
  const conversation = await host.harness.conversation(id, context);
  if (conversation === undefined) return { cost: 0 };
  let total = 0;
  let error: string | undefined;
  let cursor;
  do {
    const page = await conversation.entries({}, 256, cursor, context);
    for (const entry of page.items) {
      if (entry.kind !== "pi.assistant") continue;
      const reply = (entry.model as { usage?: { cost?: { total?: number } }; stopReason?: string; errorMessage?: string }[] | undefined)?.[0];
      total += reply?.usage?.cost?.total ?? 0;
      if (reply?.stopReason === "error") error = reply.errorMessage ?? "provider error";
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { cost: total, ...(error === undefined ? {} : { error }) };
}

const results: { name: string; expect: Outcome; got: Outcome | "timeout" | "error" | "skipped"; cost: number; error?: string }[] = [];
let spent = 0;
try {
  for (const [index, each] of cases.entries()) {
    if (spent >= budget) {
      results.push({ name: each.name, expect: each.expect, got: "skipped", cost: 0 });
      continue;
    }
    const project = projects[index]!;
    const deadline = Date.now() + CASE_TIMEOUT_MS;
    /** Wait until the task's run has stopped: closed, or waiting on the user. */
    const settled = async (): Promise<InboxTask | undefined> => {
      for (;;) {
        const current = await taskOf(project);
        const handled = current?.events.every((each) => each.handled) === true;
        if ((handled && (current?.closed === true || current?.waiting === true)) || Date.now() > deadline) return current;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    // Later events go to the same task, as a followed thread's would: the
    // score is the ending after the last one.
    let task: InboxTask | undefined;
    let notifiedBefore = 0;
    for (const [n, event] of each.events.entries()) {
      notifiedBefore = ((await host.harness.snapshot(OutboxDoc, context))?.messages ?? []).filter((message) => message.task === task?.id).length;
      await addInboxEvent(host.harness, project, { id: `${index}-${n}`, ...event, ...(task === undefined ? {} : { task: task.id }) }, context);
      task = await settled();
    }
    // Out of time: stop the run (and its subagents) before counting what it cost.
    const timedOut = Date.now() > deadline;
    if (timedOut && task?.conversationId !== undefined) {
      await (await host.harness.conversation(task.conversationId, context))?.abort(context, { background: true });
      task = await taskOf(project);
    }
    const notified = ((await host.harness.snapshot(OutboxDoc, context))?.messages ?? []).filter((message) => message.task === task?.id).length > notifiedBefore;
    const replies = task?.conversationId === undefined ? { cost: 0 } : await repliesOf(task.conversationId);
    // A run that failed says nothing about the rules: scored as an error, never as "quiet".
    const failure = task?.failed ?? replies.error;
    const got: Outcome | "timeout" | "error" =
      failure !== undefined ? "error" : timedOut ? "timeout" : task?.waiting === true ? "ask" : task?.closed !== true ? "timeout" : notified ? "notify" : "quiet";
    spent += replies.cost;
    results.push({ name: each.name, expect: each.expect, got, cost: replies.cost, ...(failure === undefined ? {} : { error: failure }) });
    console.log(
      `${got === each.expect ? "PASS" : "FAIL"}  ${each.name}: expected ${each.expect}, got ${got} ($${replies.cost.toFixed(4)})${failure === undefined ? "" : ` — ${failure}`}`,
    );
  }
} finally {
  await host.close();
  await rm(dataDir, { recursive: true, force: true });
  for (const dir of projects) await rm(dir, { recursive: true, force: true });
}

const scored = results.filter((each) => each.got !== "skipped");
const score = scored.length === 0 ? 0 : scored.filter((each) => each.got === each.expect).length / scored.length;
console.log(JSON.stringify({ model: values.model, score, passScore: Number(values["pass-score"]), spent, results }, null, 2));
process.exit(score >= Number(values["pass-score"]) ? 0 : 1);
