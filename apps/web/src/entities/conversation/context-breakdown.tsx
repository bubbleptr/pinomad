import { classify, type ContextBreakdown } from "@pinomad/protocol/presentation.ts";
import type { ContextUsage } from "@pinomad/client/context-usage.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { formatTokens, PARTS } from "./context-meter.tsx";

/**
 * The host's context breakdown, while it belongs to the reply the meter
 * counts: the host stamps it with that reply's own usage, so a different
 * `used` means another reply (a newer one not yet broken down, or a fork's
 * parent), and a missing meter means a compaction or reset made it stale.
 */
export function matchingBreakdown(docs: readonly ExtensionDocView[], usage: ContextUsage | undefined): ContextBreakdown | undefined {
  if (usage === undefined) return undefined;
  for (const doc of docs) {
    const classified = classify(doc.presentation, doc.value);
    if (classified.type === "pinomad.context" && classified.value.used === usage.used) return classified.value;
  }
  return undefined;
}

/**
 * A row per part that takes space, with its tokens and share of the window.
 * The bar above them is the context meter's own.
 */
export function ContextBreakdownList({ breakdown, window }: { breakdown: ContextBreakdown; window: number }) {
  return (
    <ul aria-label="Context breakdown" className="flex flex-col pb-1">
      {PARTS.filter((part) => breakdown[part.key] > 0).map((part) => (
        <li key={part.key} className="flex h-6 items-center gap-2 text-xs tabular-nums">
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: part.color }} />
          <span className="min-w-0 flex-1 truncate">{part.label}</span>
          <span className="text-muted-foreground">{formatTokens(breakdown[part.key])}</span>
          <span className="w-8 text-end text-muted-foreground">{Math.round((breakdown[part.key] / window) * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}
