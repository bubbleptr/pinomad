// A conversation family's rolled-up presentation: root rows in the sidebar
// speak for the whole family (forks and subagents never get rows of their
// own), so status and recency aggregate across the root and every descendant.
import { findConversation, type ConversationNode, type Organized } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";

/** A family's most urgent status; `undefined` means everything is idle. */
export type FamilyStatus = "needs-answer" | "failed" | "running";

// Deliberately NOT the host's per-conversation precedence (needs-answer >
// running > failed): at family level a failure somewhere matters more than
// something merely still in flight.
const RANK: Record<FamilyStatus, number> = { "needs-answer": 3, failed: 2, running: 1 };

/** The most urgent status among the root and all of its descendants. */
export function familyStatus(node: ConversationNode): FamilyStatus | undefined {
  let best: FamilyStatus | undefined;
  const visit = (current: ConversationNode): void => {
    const status = current.summary.status;
    if (status !== undefined && (best === undefined || RANK[status] > RANK[best])) best = status;
    for (const child of current.children) visit(child);
  };
  visit(node);
  return best;
}

/** The freshest `updatedAt` among the root and all of its descendants. */
export function familyUpdatedAt(node: ConversationNode): number | undefined {
  let newest: number | undefined;
  const visit = (current: ConversationNode): void => {
    const at = current.summary.updatedAt;
    if (at !== undefined && (newest === undefined || at > newest)) newest = at;
    for (const child of current.children) visit(child);
  };
  visit(node);
  return newest;
}

/** Compact recency for sidebar rows: "now" under a minute, then floored units. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Delegating models often open a task with this clause; it says nothing about
// what the work is.
const SUBAGENT_TASK_PREFIX = /^\s*in the working directory\s+\S+,\s*/i;

/** What a conversation is called wherever the UI names it (header, breadcrumb). */
export function displayName(summary: ConversationSummary | undefined): string {
  if (summary === undefined) return "Conversation";
  if (summary.kind !== "subagent") return summary.title ?? "New conversation";
  if (summary.label !== undefined) return summary.label;
  const title = summary.title?.replace(SUBAGENT_TASK_PREFIX, "").trim();
  return title === undefined || title === "" ? "Subagent" : title;
}

/** The top-level node a conversation belongs to — `parent` links walked to the root. */
export function rootOf(organized: Organized, id: ConversationSummary["id"]): ConversationNode | undefined {
  let found = findConversation(organized, id);
  // Fork depth is one and subagents sit one level below their owner, so this
  // loop runs at most twice — a guard keeps a corrupt link from looping.
  for (let depth = 0; found !== undefined && found.summary.parent !== undefined && depth < 4; depth++) {
    found = findConversation(organized, found.summary.parent);
  }
  return found;
}

/** The family's forks — the side panel's Threads list. */
export function threadsOf(root: ConversationNode): readonly ConversationNode[] {
  return root.children.filter((child) => child.summary.kind === "fork");
}

/** The family's subagents grouped by owner: the root first, then each fork that has any. */
export function taskGroupsOf(root: ConversationNode): { owner: ConversationSummary; label: string; tasks: ConversationNode[] }[] {
  const groups: { owner: ConversationSummary; label: string; tasks: ConversationNode[] }[] = [];
  const own = root.children.filter((child) => child.summary.kind === "subagent");
  if (own.length > 0) groups.push({ owner: root.summary, label: "This conversation", tasks: [...own] });
  for (const fork of threadsOf(root)) {
    const tasks = fork.children.filter((child) => child.summary.kind === "subagent");
    if (tasks.length > 0) groups.push({ owner: fork.summary, label: displayName(fork.summary), tasks: [...tasks] });
  }
  return groups;
}
