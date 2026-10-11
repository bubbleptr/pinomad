// System notifications for runs across every conversation: `organized`'s
// per-summary status is the source of truth, and what the user needs told
// about is a status change, not a status — so the diff below works on a
// baseline of last-seen statuses rather than the snapshots themselves.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Organized } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { displayName } from "./family.ts";

export type RunNotice = {
  readonly id: ConversationId;
  readonly title: string;
  readonly body: "Waiting for your answer" | "Finished" | "Failed";
};

export type StatusBaseline = ReadonlyMap<ConversationId, ConversationSummary["status"]>;

const everySummary = (organized: Organized): ConversationSummary[] => {
  const summaries: ConversationSummary[] = [];
  const visit = (node: ConversationNode): void => {
    summaries.push(node.summary);
    for (const child of node.children) visit(child);
  };
  for (const root of [...organized.chats, ...organized.projects.flatMap((entry) => entry.conversations)]) visit(root);
  return summaries;
};

/**
 * The notifications one `organized` update produces, the ids whose status
 * moved (`changed`, for retiring still-visible notifications), and the
 * baseline it leaves behind. `previous === undefined` seeds the baseline
 * without notifying — at connect time half the sidebar may be mid-run or
 * waiting and none of it is news. A conversation missing from `previous`
 * counts as having been idle; one gone from `organized` drops out of the
 * baseline and counts as changed.
 */
export function diffRunNotices(
  previous: StatusBaseline | undefined,
  organized: Organized,
): { notices: RunNotice[]; changed: ConversationId[]; baseline: StatusBaseline } {
  const notices: RunNotice[] = [];
  const changed: ConversationId[] = [];
  const baseline = new Map<ConversationId, ConversationSummary["status"]>();
  for (const summary of everySummary(organized)) {
    baseline.set(summary.id, summary.status);
    if (previous === undefined) continue;
    const before = previous.get(summary.id);
    // `changed` isn't only about notices: a state move also retires whatever
    // notification the previous state left on screen.
    if (before !== summary.status) changed.push(summary.id);
    if (summary.status === "needs-answer" && before !== "needs-answer") {
      // Any kind, subagents included: a waiting question blocks until answered.
      notices.push({ id: summary.id, title: displayName(summary), body: "Waiting for your answer" });
      continue;
    }
    const runEnded = before === "running" || before === "needs-answer";
    if (runEnded && (summary.status === undefined || summary.status === "failed") && summary.kind !== "subagent") {
      // Subagents run back-to-back under their owner — a finished task isn't
      // worth interrupting for the way a waiting question is.
      notices.push({ id: summary.id, title: displayName(summary), body: summary.status === "failed" ? "Failed" : "Finished" });
    }
  }
  if (previous !== undefined) {
    for (const gone of previous.keys()) {
      if (!baseline.has(gone)) changed.push(gone);
    }
  }
  return { notices, changed, baseline };
}

/**
 * Ask for permission inside a user gesture — browsers ignore requests outside
 * one, so the ask piggybacks on sending a prompt rather than firing at
 * startup. No-op where the API is missing or the answer is already decided.
 */
export function requestNotificationPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission();
}
