// Inbox task states (ADR-0051 §2): not stored, derived from the task and its
// conversation. The sidebar lists them as "waiting for you / in progress /
// pending / done".
import type { ConversationId } from "@earendil-works/pi-durable";
import type { HostInbox, InboxTask } from "@pinomad/protocol/inbox.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";

export type InboxTaskState = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";

/**
 * What a task reads as. `summary` is its conversation's, when it has one.
 * A closed task reads as how it closed. An open one follows its
 * conversation's live status when it has one (a question, or a run — events
 * that arrive meanwhile wait for the next batch), else the worker's marks
 * (parked on a question, a batch out), then pending while events wait to be
 * sent. An open task with nothing left to send is about to close.
 */
export function inboxTaskState(task: InboxTask, summary?: ConversationSummary): InboxTaskState {
  if (task.failed !== undefined) return "failed";
  if (task.skipped === true) return "skipped";
  if (task.closed) return "done";
  // The conversation's live status first: the task's `waiting` stays set
  // until the answered run settles, while the run is already going again.
  if (summary?.status === "needs-answer") return "waiting";
  if (summary?.status === "running") return "running";
  if (task.waiting === true) return "waiting";
  if (task.inFlight === true) return "running";
  if (task.events.some((event) => !event.handled)) return "pending";
  return "done";
}

export type InboxGroupName = "waiting" | "running" | "pending" | "done";

export interface InboxGroup {
  readonly group: InboxGroupName;
  readonly tasks: readonly InboxTask[];
}

const GROUP_OF: Record<InboxTaskState, InboxGroupName> = {
  waiting: "waiting",
  running: "running",
  pending: "pending",
  done: "done",
  skipped: "done",
  failed: "done",
};

const lastEventAt = (task: InboxTask): number => Math.max(task.createdAt, ...task.events.map((event) => event.receivedAt));
const firstPendingAt = (task: InboxTask): number =>
  Math.min(...task.events.filter((event) => !event.handled).map((event) => event.receivedAt));

/**
 * The sidebar's groups, always all four in order. Pending tasks come in the
 * worker's order (the longest-waiting event first); the others newest
 * activity first. Ties keep the tasks' own order.
 */
export function groupInboxTasks(tasks: readonly InboxTask[], summaries: readonly ConversationSummary[]): InboxGroup[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const groups: Record<InboxGroupName, InboxTask[]> = { waiting: [], running: [], pending: [], done: [] };
  for (const task of tasks) {
    const summary = task.conversationId === undefined ? undefined : byId.get(task.conversationId);
    groups[GROUP_OF[inboxTaskState(task, summary)]].push(task);
  }
  const newestFirst = (list: InboxTask[]): InboxTask[] => list.sort((a, b) => lastEventAt(b) - lastEventAt(a));
  return [
    { group: "waiting", tasks: newestFirst(groups.waiting) },
    { group: "running", tasks: newestFirst(groups.running) },
    { group: "pending", tasks: groups.pending.sort((a, b) => firstPendingAt(a) - firstPendingAt(b)) },
    { group: "done", tasks: newestFirst(groups.done) },
  ];
}

/** The conversations of every Inbox task: their runs end without a Finished notice (ADR-0051 §9). */
export function inboxRunIds(inbox: HostInbox | null): ReadonlySet<ConversationId> {
  const ids = new Set<ConversationId>();
  for (const each of inbox?.inboxes ?? []) {
    for (const task of each.tasks) if (task.conversationId !== undefined) ids.add(task.conversationId);
  }
  return ids;
}
