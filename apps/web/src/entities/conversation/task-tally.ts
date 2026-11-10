import type { ConversationSummary } from "@pinomad/protocol/view.ts";

const ACTIVE_STATUS = new Set<ConversationSummary["status"]>(["running", "needs-answer"]);

/** A family's subagents by state: still working (or waiting on you), finished, failed. */
export function taskTally(tasks: readonly ConversationSummary[]): {
  readonly active: readonly ConversationSummary[];
  readonly done: number;
  readonly failed: number;
} {
  const active = tasks.filter((task) => ACTIVE_STATUS.has(task.status));
  const failed = tasks.filter((task) => task.status === "failed").length;
  return { active, done: tasks.length - active.length - failed, failed };
}
