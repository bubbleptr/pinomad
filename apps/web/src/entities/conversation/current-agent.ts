import type { ConversationSummary } from "@pinomad/protocol/view.ts";

/**
 * The agent a top-level conversation or fork runs as. A 5.18 host reports
 * `currentAgent` — absent only from older hosts, where the creation agent is
 * all the summary knows; `null` means the conversation has no agent.
 */
export function currentAgentOf(summary: ConversationSummary | undefined): string | undefined {
  if (summary === undefined) return undefined;
  return summary.currentAgent === undefined ? summary.role : summary.currentAgent ?? undefined;
}
