import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { subagentTone, type TaskTone } from "./task-glyph.tsx";

const RANK: Record<TaskTone, number> = { running: 0, failed: 1, done: 2 };

/**
 * The Tasks order: subagents at work first, in the host's order (the order
 * they were started in), then failed ones, then finished ones, each newest
 * first.
 */
export function orderedSubagents(tasks: readonly ConversationSummary[]): ConversationSummary[] {
  return [...tasks].sort((a, b) => {
    const rank = RANK[subagentTone(a.status)] - RANK[subagentTone(b.status)];
    if (rank !== 0 || subagentTone(a.status) === "running") return rank;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

/** "now", or how long ago with the unit `relativeTime` gives it ("8m ago"). */
export function agoText(relative: string): string {
  return relative === "now" ? "now" : `${relative} ago`;
}
