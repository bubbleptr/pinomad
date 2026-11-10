// How the web names a subagent and whether the user can stop it
// (ADR-0046 §1, ADR-0047 §2).
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
 * Whether the user can stop this subagent now (ADR-0047 §2): it is at work,
 * and the host tells its dispatcher who stopped it — a 5.33 host, for a
 * subagent it has a record of (it has a name). The user never messages a
 * subagent; an idle one has nothing to stop.
 */
export function canStopSubagent(summary: ConversationSummary, hostMinor: number): boolean {
  return hostSupportsFeature(hostMinor, "subagentStop") && summary.name !== undefined && summary.status === "running";
}
