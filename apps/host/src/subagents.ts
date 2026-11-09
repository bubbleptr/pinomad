// One kind of subagent (ADR-0046): named, idle after answering, messageable
// and stoppable later. Core holds the family registry and the two task kinds
// so both the subagent tools (extensions/subagent.ts registers the tasks) and
// the gateway (a user's message or Stop) use one path. Ownership follows
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
  /** The conversation whose model dispatched it; user messages are reported there. */
  dispatcher: ConversationId;
  /** The `subagent` call that created it: a rerun of that call finds it by this. */
  createdBy: TaskId;
  /** Foreground only: the call it is still answering; cleared when the call settles it. */
  call?: TaskId;
  checkout: "shared";
  description?: string;
  status: SubagentStatus;
  /** Reporter tasks not yet settled. */
  reporters: TaskId[];
  /** Answers already reported, by entry id: several messages can end in one answer. */
  reported: Record<string, "steer" | "write">;
  /** The newest child entry `subagent_read` returned. */
  readUpTo?: EntryId;
  /** Request ids of the user's own messages that `subagent_read` has not returned yet. */
  userRequests?: string[];
  /** Who stopped its current work, recorded before the abort; cleared by the next message. */
  stop?: { by: "user" | "model"; noted: boolean };
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
  readonly from: "model" | "user";
  /** From the model: the message to deliver. */
  readonly message?: string;
  /** From the user: the request id the gateway admitted the message under, in the same commit. */
  readonly requestId?: string;
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
export const SubagentReporter = defineTask<ReporterInput, { phase: "deliver" }, null>({
  name: "pinomad.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, context) => {
      const input = reporter.input;
      const child = await runtime.conversation(input.conversationId, context);
      let settled: SettledSubmissionRecord | undefined;
      if (child !== undefined) {
        // A request id makes a rerun after a restart find the first admission.
        // A user's message was admitted with the reporter; its content is not
        // read again, only its request id.
        const draft: SubmissionDraft =
          input.from === "user"
            ? { type: "input", content: "", requestId: input.requestId! }
            : { type: "input", content: input.message!, whenBusy: "steer", requestId: `subagent:${reporter.id}` };
        settled = await (await child.submit(draft, context)).wait(context);
      }
      const sender = (await runtime.conversation(runtime.conversationId, context))!;
      await runtime.commit(async (tx) => {
        await settle(tx, sender, reporter.id, input, settled, runtime.now());
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

function release(record: SubagentRecord, reporter: TaskId, status: SubagentStatus): void {
  record.reporters = record.reporters.filter((id) => id !== reporter);
  if (record.reporters.length === 0) record.status = status;
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
  settled: SettledSubmissionRecord | undefined,
  now: number,
): Promise<void> {
  const record = (await tx.doc(SubagentsDoc, input.root)).agents[input.name];
  if (record === undefined) return;
  const name = input.name;
  let report: SubmissionDraft | undefined;
  let status: SubagentStatus;
  if (settled?.status === "done" && settled.type === "input") {
    status = "idle";
    const key = String(settled.answer);
    const prior = record.reported[key];
    if (input.from === "model" && prior !== "steer") {
      // A message from the model wakes it with the answer, even when a user
      // message ended in the same answer and was only noted.
      report = steer(`[subagent ${name} answered]\n\n${await answerText(tx, settled.answer)}`);
      record.reported[key] = "steer";
    } else if (input.from === "user" && prior === undefined) {
      const turns = (await userMessages(tx, record)).count;
      report = note(
        `[The user talked with subagent ${name} directly: ${turns} message${turns === 1 ? "" : "s"} since you last read it. Call subagent_read to see them.]`,
        now,
      );
      record.reported[key] = "write";
    }
  } else if (settled?.status === "unanswered" && settled.reason === "aborted") {
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
    report =
      input.from === "model"
        ? steer(`[subagent ${name} failed: ${reason}]`)
        : note(`[The user's message to subagent ${name} failed: ${reason}]`, now);
  }
  if (report !== undefined) await sender.submit(tx, { ...report, requestId: `subagent-report:${reporter}` });
  release(record, reporter, status);
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

/** The user's own messages since the read cursor: their entries once placed, and how many there are. */
export async function userMessages(tx: Tx, record: SubagentRecord): Promise<{ entries: Set<EntryId>; count: number }> {
  const entries = new Set<EntryId>();
  let count = 0;
  for (const requestId of record.userRequests ?? []) {
    const entry = (await tx.submissionByRequest(record.conversationId, requestId))?.entry;
    if (entry !== undefined) entries.add(entry);
    if (entry === undefined || record.readUpTo === undefined || entry > record.readUpTo) count++;
  }
  return { entries, count };
}

/** Advance the read cursor and drop the user requests it now covers. */
export async function markRead(tx: Tx, record: SubagentRecord, upTo: EntryId): Promise<void> {
  record.readUpTo = upTo;
  const left: string[] = [];
  for (const requestId of record.userRequests ?? []) {
    const entry = (await tx.submissionByRequest(record.conversationId, requestId))?.entry;
    if (entry === undefined || entry > upTo) left.push(requestId);
  }
  record.userRequests = left;
}

/**
 * Record the dispatch of one message inside a commit: a reporter task owned
 * by `sender` (background, so its Esc and idle waits skip it), and the
 * subagent marked working. Call it after any admission in the same commit.
 */
export async function dispatch(
  tx: Tx,
  options: {
    readonly root: ConversationId;
    readonly name: string;
    readonly sender: ConversationId;
    readonly from: "model" | "user";
    readonly message?: string;
    readonly requestId?: string;
  },
): Promise<TaskId> {
  const agents = (await tx.doc(SubagentsDoc, options.root)).agents;
  const record = recordNamed(agents, options.name);
  if (await inCall(tx, record)) {
    throw new Error(`Subagent "${options.name}" is still answering the subagent call that dispatched it`);
  }
  const working = record.reporters.length > 0;
  if (!working) await assertCapacity(tx, options.root);
  const reporter = await tx.createTask(
    SubagentReporter,
    {
      root: options.root,
      name: options.name,
      conversationId: record.conversationId,
      from: options.from,
      ...(options.message === undefined ? {} : { message: options.message }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    },
    { ownership: { kind: "conversation" }, conversationId: options.sender, background: true },
  );
  record.reporters.push(reporter);
  // Assign a new array: a document proxy stores a copy of an assigned value.
  if (options.from === "user" && options.requestId !== undefined) record.userRequests = [...(record.userRequests ?? []), options.requestId];
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
  found.record.stop = { by, noted: false };
  return true;
}
