// One kind of subagent (ADR-0046): named, idle after answering, messageable
// by the model and stoppable later. Core holds the family registry and the two
// task kinds so both the subagent tools (extensions/subagent.ts registers the
// tasks) and the gateway (a user's Stop; ADR-0047) use one path. Ownership follows
// pi-durable's example 22: a background-dispatched child is owned by an
// anchor task that ends at once; every message after the first call is
// delivered by a background reporter task of the sending conversation, which
// settles the subagent's status and tells that conversation in one commit, so
// a restart neither loses nor repeats a report.
import {
  AssistantEntry,
  type ConversationHandle,
  type ConversationId,
  defineDoc,
  defineTask,
  type EntryId,
  type EntryRecord,
  type SettledSubmissionRecord,
  type SubmissionDraft,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { SubagentDoc } from "./subagent-doc.ts";

export type SubagentStatus = "working" | "idle" | "stopped" | "failed";

export type SubagentRecord = {
  conversationId: ConversationId;
  /** The conversation whose model dispatched it. */
  dispatcher: ConversationId;
  /** The `subagent` call that created it: a rerun of that call finds it by this. */
  createdBy: TaskId;
  /** Foreground only: the call it is still answering; cleared when the call settles it. */
  call?: TaskId;
  checkout: "shared" | "worktree";
  /** Worktree only: its own branch and the commit it started at (ADR-0046 §5). */
  branch?: string;
  base?: string;
  description?: string;
  status: SubagentStatus;
  /** Reporter tasks not yet settled. */
  reporters: TaskId[];
  /**
   * Answers already reported, keyed `<receiving conversation>:<answer entry>`: several messages can end in one answer.
   * "write" is left from when a user's own messages were only noted (before ADR-0047).
   */
  reported: Record<string, "steer" | "write">;
  /** The newest child entry `subagent_read` returned. */
  readUpTo?: EntryId;
  /** Who stopped its current work, recorded before the abort; cleared by the next message. */
  stop?: { by: "user" | "model"; noted: boolean };
  /** Reporters a Stop reached before they delivered their message: they must not deliver it. */
  cancelled?: TaskId[];
};

/** Registry of a root family's subagents, kept on the family root: names are unique there (ADR-0046 §1, §3). */
export const SubagentsDoc = defineDoc<{ agents: Record<string, SubagentRecord> }>({
  kind: "pinomad.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork of the root starts empty; the root's copy stays the family's registry.
  fork: "initial",
  initial: () => ({ agents: {} }),
  checkpointWhen: () => false,
});

/** At most this many subagents of one root family work at once; idle ones do not count (ADR-0046 §7). */
export const MAX_WORKING_SUBAGENTS = 8;

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;

/** The top of `id`'s family inside a commit, following fork parents and subagent owners. */
export async function familyRootIn(tx: Tx, id: ConversationId): Promise<ConversationId> {
  let current = id;
  for (let depth = 0; depth < 256; depth++) {
    const record = await tx.conversation(current);
    const up = record?.parent?.conversationId ?? record?.owner?.conversationId;
    if (up === undefined) return current;
    current = up;
  }
  return current;
}

/** A name derived from the call's description: lowercase words joined by "-". */
export function nameFromDescription(description: string | undefined): string {
  const base = (description ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return base === "" ? "subagent" : base;
}

/** `base`, or `base-2`, `base-3`… — the first one not taken. */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

export function assertValidName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`Invalid subagent name "${name}": use 1-40 letters, digits, "-" or "_", starting with a letter or digit`);
  }
}

async function isLive(tx: Tx, id: TaskId | undefined): Promise<boolean> {
  if (id === undefined) return false;
  const task = await tx.task(id);
  return task !== undefined && task.state.status !== "terminal";
}

/** Whether it is still inside the foreground call that dispatched it. */
export async function inCall(tx: Tx, record: SubagentRecord): Promise<boolean> {
  return await isLive(tx, record.call);
}

/** The status to show: a foreground call cut off by an abort or a crash never wrote its outcome. */
export async function statusOf(tx: Tx, record: SubagentRecord): Promise<SubagentStatus> {
  if (record.status !== "working" || record.reporters.length > 0 || (await inCall(tx, record))) return record.status;
  return "stopped";
}

async function workingCount(tx: Tx, root: ConversationId): Promise<number> {
  let count = 0;
  for (const record of Object.values((await tx.doc(SubagentsDoc, root)).agents)) {
    if (record.reporters.length > 0 || (await inCall(tx, record))) count++;
  }
  return count;
}

/** Refuse a new working subagent past the family's limit. */
export async function assertCapacity(tx: Tx, root: ConversationId): Promise<void> {
  if ((await workingCount(tx, root)) >= MAX_WORKING_SUBAGENTS) {
    throw new Error(
      `At most ${MAX_WORKING_SUBAGENTS} subagents can work at once in this conversation; wait for one to answer or stop one with subagent_stop`,
    );
  }
}

/** The registry entry for `name`, or a thrown error naming the ones that exist. */
export function recordNamed(agents: Record<string, SubagentRecord>, name: string): SubagentRecord {
  const found = Object.hasOwn(agents, name) ? agents[name] : undefined;
  if (found !== undefined) return found;
  const names = Object.keys(agents);
  throw new Error(names.length === 0 ? `No subagent named "${name}"` : `No subagent named "${name}". Subagents: ${names.join(", ")}`);
}

/** The registry name and entry of a subagent conversation, if the family registry has it. */
export async function recordOf(
  tx: Tx,
  childId: ConversationId,
): Promise<{ root: ConversationId; name: string; record: SubagentRecord } | undefined> {
  if ((await tx.conversation(childId))?.owner === undefined) return undefined;
  const root = await familyRootIn(tx, childId);
  const agents = (await tx.doc(SubagentsDoc, root)).agents;
  for (const [name, record] of Object.entries(agents)) {
    if (record.conversationId === childId) return { root, name, record };
  }
  return undefined;
}

type ReporterInput = {
  readonly root: ConversationId;
  readonly name: string;
  readonly conversationId: ConversationId;
  /** Absent on a reporter left from when the user could message a subagent (before ADR-0047): it delivers nothing. */
  readonly message?: string;
};

/** Owns a background-dispatched child and ends at once; a background task is a boundary for Esc and idle waits. */
export const SubagentAnchor = defineTask<null, { phase: "done" }, null>({
  name: "pinomad.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
  },
  abort: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Delivers one message to a subagent, waits for its answer, and reports it (ADR-0046 §2-§4). */
export const SubagentReporter = defineTask<ReporterInput, { phase: "deliver" } | { phase: "wait" }, null>({
  name: "pinomad.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    // The message is admitted in a commit that first checks for a Stop that
    // reached this reporter, so a stopped subagent never restarts on a
    // message sent before the Stop.
    deliver: async (reporter, runtime, context) => {
      const input = reporter.input;
      const child = await runtime.conversation(input.conversationId, context);
      const sender = (await runtime.conversation(runtime.conversationId, context))!;
      await runtime.commit(async (tx) => {
        const record = (await tx.doc(SubagentsDoc, input.root)).agents[input.name];
        if (input.message === undefined) {
          if (record !== undefined) release(record, reporter.id, "idle");
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }
        const message = input.message;
        if (child !== undefined) {
          if (record?.cancelled?.includes(reporter.id) === true) {
            await settle(tx, sender, reporter.id, input, "cancelled", runtime.now());
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          await child.submit(tx, draftOf(reporter.id, message));
        }
        return { status: "running", checkpoint: { phase: "wait" } };
      }, context);
    },
    wait: async (reporter, runtime, context) => {
      const input = reporter.input;
      const child = await runtime.conversation(input.conversationId, context);
      // The request id finds the admission made earlier, also after a restart.
      const message = input.message;
      const settled =
        child === undefined || message === undefined ? undefined : await (await child.submit(draftOf(reporter.id, message), context)).wait(context);
      const sender = (await runtime.conversation(runtime.conversationId, context))!;
      await runtime.commit(async (tx) => {
        if (message === undefined) {
          const record = (await tx.doc(SubagentsDoc, input.root)).agents[input.name];
          if (record !== undefined) release(record, reporter.id, "idle");
        } else {
          await settle(tx, sender, reporter.id, input, settled, runtime.now());
        }
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: (reporter, runtime, context) =>
    runtime.commit(async (tx) => {
      const record = (await tx.doc(SubagentsDoc, reporter.input.root)).agents[reporter.input.name];
      if (record !== undefined) release(record, reporter.id, "stopped");
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
});

/** The reporter's message as admitted; the request id finds the admission again. */
function draftOf(reporter: TaskId, message: string): SubmissionDraft {
  return { type: "input", content: message, whenBusy: "steer", requestId: `subagent:${reporter}` };
}

function release(record: SubagentRecord, reporter: TaskId, status: SubagentStatus): void {
  record.reporters = record.reporters.filter((id) => id !== reporter);
  if (record.cancelled !== undefined) record.cancelled = record.cancelled.filter((id) => id !== reporter);
  if (record.reporters.length === 0) record.status = status;
}

/** Record a Stop before the abort: who stopped it, and the reporters it reaches (ADR-0046 §4). */
export function stopRecord(record: SubagentRecord, by: "user" | "model"): void {
  record.stop = { by, noted: false };
  record.cancelled = [...record.reporters];
}

function steer(text: string): SubmissionDraft {
  return { type: "input", content: text, whenBusy: "steer" };
}

function note(text: string, now: number): SubmissionDraft {
  // A write with model content wakes nobody: an idle conversation takes it
  // into context at once, a busy one at its next boundary.
  return { type: "write", entry: { kind: "pi.user", model: [{ role: "user", content: text, timestamp: now }] } };
}

/** The settle commit: decide the report, admit it, then write the status — one commit (ADR-0046 §3). */
async function settle(
  tx: Tx,
  sender: ConversationHandle,
  reporter: TaskId,
  input: ReporterInput,
  settled: SettledSubmissionRecord | "cancelled" | undefined,
  now: number,
): Promise<void> {
  const record = (await tx.doc(SubagentsDoc, input.root)).agents[input.name];
  if (record === undefined) return;
  const name = input.name;
  let report: SubmissionDraft | undefined;
  let status: SubagentStatus;
  if (settled !== "cancelled" && settled?.status === "done" && settled.type === "input") {
    status = "idle";
    // Per receiving conversation: the root and a fork may both wait on one answer.
    const key = `${sender.id}:${settled.answer}`;
    if (record.reported[key] !== "steer") {
      report = steer(`${answeredHeader(name, record)}\n\n${await answerText(tx, settled.answer)}`);
      record.reported[key] = "steer";
    }
  } else if (settled === "cancelled" || (settled?.status === "unanswered" && settled.reason === "aborted")) {
    status = "stopped";
    // No recorded source: the dispatcher's own Stop reached a child that was
    // dispatched in the foreground (it stays in the dispatcher's scope).
    const stop = record.stop ?? { by: "user" as const, noted: false };
    if (stop.by === "user" && !stop.noted) {
      report = note(`[The user stopped subagent ${name}.]`, now);
      stop.noted = true;
    }
    record.stop = stop;
  } else {
    status = "failed";
    const reason = settled === undefined ? "its conversation no longer exists" : settled.status === "unanswered" ? settled.reason : "no answer";
    report = steer(`[subagent ${name} failed: ${reason}]`);
  }
  if (report !== undefined) await sender.submit(tx, { ...report, requestId: `subagent-report:${reporter}` });
  release(record, reporter, status);
}

/** The first line of an answer's report: names the subagent, and its branch when it has its own worktree. */
export function answeredHeader(name: string, record: { readonly branch?: string; readonly base?: string } | undefined): string {
  return record?.branch === undefined
    ? `[subagent ${name} answered]`
    : `[subagent ${name} answered on branch ${record.branch} (from ${record.base?.slice(0, 12) ?? "?"})]`;
}

/** The text of an assistant entry; pi-ai's assistant content is always a block array. */
export async function answerText(tx: Tx, id: EntryId): Promise<string> {
  const message = (await tx.entry(AssistantEntry, id))?.model?.[0];
  const text = message?.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") : "";
  return text === "" ? "(The subagent returned no text.)" : text;
}

/** Child entries after `subagent_read`'s cursor, oldest first. */
export async function entriesSince(tx: Tx, record: SubagentRecord): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await tx.scanEntries(
      {
        conversationId: record.conversationId,
        order: "ascending",
        ...(record.readUpTo === undefined ? {} : { minEntryId: (record.readUpTo + 1) as EntryId }),
      },
      256,
      cursor,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

/**
 * Check that `name` can take a message now: it exists, is not inside the
 * foreground call that dispatched it, and the family has room. Reads tables,
 * so call it before the commit's first table write (pi-durable rejects table
 * reads after one).
 */
export async function assertDispatchable(tx: Tx, root: ConversationId, name: string): Promise<SubagentRecord> {
  const record = recordNamed((await tx.doc(SubagentsDoc, root)).agents, name);
  if (await inCall(tx, record)) {
    throw new Error(`Subagent "${name}" is still answering the subagent call that dispatched it`);
  }
  if (record.reporters.length === 0) await assertCapacity(tx, root);
  return record;
}

/**
 * Record the dispatch of one message inside a commit: a reporter task owned
 * by `sender` (background, so its Esc and idle waits skip it), and the
 * subagent marked working. Check with `assertDispatchable` first.
 */
export async function dispatch(
  tx: Tx,
  options: {
    readonly root: ConversationId;
    readonly name: string;
    readonly sender: ConversationId;
    readonly message: string;
  },
): Promise<TaskId> {
  const record = recordNamed((await tx.doc(SubagentsDoc, options.root)).agents, options.name);
  const reporter = await tx.createTask(
    SubagentReporter,
    {
      root: options.root,
      name: options.name,
      conversationId: record.conversationId,
      message: options.message,
    },
    { ownership: { kind: "conversation" }, conversationId: options.sender, background: true },
  );
  record.reporters.push(reporter);
  record.status = "working";
  delete record.stop;
  delete record.call;
  // ADR-0046 §6: running outside its call makes it background, once.
  const doc = await tx.doc(SubagentDoc, record.conversationId);
  if (doc.lifecycle !== "background") doc.lifecycle = "background";
  return reporter;
}

/** Record who stops a subagent's current work, before the abort, so its reporters know (ADR-0046 §4). */
export async function markStop(tx: Tx, childId: ConversationId, by: "user" | "model"): Promise<boolean> {
  const found = await recordOf(tx, childId);
  if (found === undefined) return false;
  stopRecord(found.record, by);
  return true;
}
