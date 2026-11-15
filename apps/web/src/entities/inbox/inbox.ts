// Where a conversation sits in the Inbox (ADR-0051) and how Inbox things read.
// The task states and groups themselves come from @pinomad/client/inbox.ts.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { HostInbox, InboxEventSource, InboxTask, ProjectInbox } from "@pinomad/protocol/inbox.ts";
import { groupInboxTasks, inboxTaskState, type InboxGroupName, type InboxTaskState } from "@pinomad/client/inbox.ts";
import { findConversation, type Organized } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";

/** Every conversation the Inbox owns: intakes and task (and tidy-up) conversations. They stay out of the coding sidebar. */
export function inboxConversationIds(inbox: HostInbox | null): ReadonlySet<ConversationId> {
  const ids = new Set<ConversationId>();
  for (const each of inbox?.inboxes ?? []) {
    if (each.intake !== undefined) ids.add(each.intake);
    for (const task of each.tasks) if (task.conversationId !== undefined) ids.add(task.conversationId);
  }
  return ids;
}

/** The project Inbox a conversation belongs to, and its task unless it is the intake. */
export function inboxOfConversation(
  inbox: HostInbox | null,
  conversationId: ConversationId | undefined,
): { inbox: ProjectInbox; task?: InboxTask } | undefined {
  if (conversationId === undefined) return undefined;
  for (const each of inbox?.inboxes ?? []) {
    if (each.intake === conversationId) return { inbox: each };
    const task = each.tasks.find((candidate) => candidate.conversationId === conversationId);
    if (task !== undefined) return { inbox: each, task };
  }
  return undefined;
}

export const GROUP_LABEL: Record<InboxGroupName, string> = {
  waiting: "Waiting for you",
  running: "In progress",
  pending: "Queued",
  done: "Done",
};

/** Where an event came from, in words. */
export function sourceLabel(source: InboxEventSource): string {
  switch (source) {
    case "user":
      return "From you";
    case "schedule":
      return "Scheduled";
    case "followUp":
      return "Follow-up";
    case "webhook":
      return "Webhook";
    default:
      return source.startsWith("plugin:") ? source.slice("plugin:".length) : source;
  }
}

/** What started a task: its first event's source, or the tidy-up. */
export function taskOrigin(task: InboxTask): string {
  if (task.kind === "tidy") return "Memory tidy-up";
  const first = task.events[0];
  return first === undefined ? "Inbox" : sourceLabel(first.source);
}

export interface InboxTaskInfo {
  readonly task: InboxTask;
  readonly state: InboxTaskState;
  readonly group: InboxGroupName;
  /** The state in words, with the queue position while queued. */
  readonly text: string;
}

/** Every task of an Inbox with its state and, while queued, its place in the worker's order. */
export function describeTasks(inbox: ProjectInbox, organized: Organized): Map<string, InboxTaskInfo> {
  const summaryOf = (task: InboxTask) =>
    task.conversationId === undefined ? undefined : findConversation(organized, task.conversationId)?.summary;
  const summaries = inbox.tasks.flatMap((task) => {
    const summary = summaryOf(task);
    return summary === undefined ? [] : [summary];
  });
  const described = new Map<string, InboxTaskInfo>();
  for (const { group, tasks } of groupInboxTasks(inbox.tasks, summaries)) {
    tasks.forEach((task, index) => {
      const summary = summaryOf(task);
      const state = inboxTaskState(task, summary);
      described.set(task.id, { task, state, group, text: taskStateText(state, task, summary, group === "pending" ? index + 1 : undefined) });
    });
  }
  return described;
}

/** A task's state in words; `position` is its place in the queue (1-based) while queued. */
export function taskStateText(state: InboxTaskState, task: InboxTask, summary?: ConversationSummary, position?: number): string {
  switch (state) {
    case "waiting":
      return "Needs your answer";
    case "running": {
      const activity = summary?.activity;
      if (activity === undefined) return "Working";
      const tool = toolDisplayName(activity.tool) ?? activity.tool;
      return `Working · ${tool}${activity.target === undefined ? "" : ` ${activity.target}`}`;
    }
    case "pending":
      return position === undefined ? "Queued" : `#${position} in queue`;
    case "skipped":
      return "Skipped";
    case "failed":
      return `Failed: ${task.failed ?? "unknown error"}`;
    case "done":
      return "Done";
  }
}
