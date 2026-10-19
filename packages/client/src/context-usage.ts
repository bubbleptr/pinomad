// Context-window usage of the shown conversation, after pi's
// AgentSession.getContextUsage (packages/coding-agent/src/core/agent-session.ts,
// MIT, Earendil Works): the newest qualifying assistant entry's usage is the
// context the model actually saw at that call, so it stays the meter's truth
// until the next reply lands — no estimation of the messages sent since.
// See docs/licenses/pi.md for the upstream notice.
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

export interface ContextUsage {
  /** Context tokens the last qualifying reply reported seeing. */
  readonly used: number;
  /** The shown model's context window; `used` may exceed it after a model swap. */
  readonly window: number;
}

/** pi-ai's `Usage` fields the meter reads; the entry cast is the contract. */
type UsageLike = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
};

type AssistantMessageLike = {
  readonly role: "assistant";
  readonly stopReason?: string;
  readonly usage?: UsageLike;
};

/** Upstream `calculateContextTokens`: the provider's total wins when it reports one. */
const contextTokens = (usage: UsageLike): number =>
  usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

/**
 * The conversation's context fill, for the composer meter. Scans the active
 * entries back from the tail — a `pi.compaction` or `pi.reset` ends the
 * search with nothing (the last reply's usage predates the cut and cannot be
 * trusted until the next response arrives), an aborted or failed reply and a
 * zero-usage message carry no trustworthy count. `contextWindow` comes from
 * the shown model's `ModelSummary`; absent or non-positive means the meter
 * has no scale and reads undefined.
 */
export function contextUsage(view: ConversationView, contextWindow: number | undefined): ContextUsage | undefined {
  if (contextWindow === undefined || !(contextWindow > 0)) return undefined;
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index] as EntryRecord;
    if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") return undefined;
    if (entry.kind !== "pi.assistant") continue;
    const message = entry.model?.[0] as AssistantMessageLike | undefined;
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    // The upstream falsy guard on `usage` — a null one would throw on read.
    const used = !message.usage ? 0 : contextTokens(message.usage);
    if (!(used > 0)) continue;
    return { used, window: contextWindow };
  }
  return undefined;
}
