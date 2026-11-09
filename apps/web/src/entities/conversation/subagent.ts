// How the web names a subagent and whether the user can talk to it
// (ADR-0046 §1, §6).
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { displayName } from "@pinomad/client/family.ts";

/**
 * What a conversation is called in the web UI: a subagent goes by its
 * family-unique name — the one its parent's reports and the subagent tools
 * use — and falls back to the shared display name on older hosts.
 */
export function conversationName(summary: ConversationSummary | undefined): string {
  if (summary?.kind === "subagent" && summary.name !== undefined) return summary.name;
  return displayName(summary);
}

/**
 * - `read-only`: a host without `subagentMessages`, or a subagent from before
 *   ADR-0046 (no name), which the host refuses messages for.
 * - `in-call`: a foreground subagent that is running is still answering the
 *   call that dispatched it; the host refuses messages until the call ends,
 *   but Stop works (the call then fails, like Esc).
 * - `open`: messages and Stop.
 */
export type SubagentMessaging = "read-only" | "in-call" | "open";

export function subagentMessaging(summary: ConversationSummary, hostMinor: number): SubagentMessaging {
  if (!hostSupportsFeature(hostMinor, "subagentMessages") || summary.name === undefined) return "read-only";
  // Running outside its call turns a subagent background in the same commit
  // (ADR-0046 §6), so a running foreground one is necessarily inside it.
  if (summary.lifecycle !== "background" && summary.status === "running") return "in-call";
  return "open";
}
