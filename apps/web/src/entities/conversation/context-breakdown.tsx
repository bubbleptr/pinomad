import { classify, type ContextBreakdown } from "@pinomad/protocol/presentation.ts";
import type { ContextUsage } from "@pinomad/client/context-usage.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { formatTokens } from "./context-meter.tsx";

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

// The app's categorical data palette (styles.css), even in lightness across
// themes. Messages take blue: the part the user produces and the one that grows.
const PARTS = [
  { key: "system", label: "System", color: "var(--pigui-data-slate)" },
  { key: "skills", label: "Skills", color: "var(--pigui-data-amber)" },
  { key: "tools", label: "Tools", color: "var(--pigui-data-green)" },
  { key: "mcp", label: "MCP", color: "var(--pigui-data-orange)" },
  { key: "messages", label: "Messages", color: "var(--pigui-data-blue)" },
] as const;

/**
 * What fills the context window: one stacked bar on the window's scale, and a
 * row per part that takes space. The bar is decoration — the rows carry the
 * figures, and the meter above already announces the total. Past the window
 * (after a swap to a smaller model) the bar scales to the total instead.
 */
export function ContextBreakdownList({ breakdown, window }: { breakdown: ContextBreakdown; window: number }) {
  const scale = Math.max(window, breakdown.used);
  const shown = PARTS.filter((part) => breakdown[part.key] > 0);
  return (
    <div className="flex flex-col gap-1.5 pb-1">
      <div aria-hidden className="flex h-1.5 gap-px overflow-hidden rounded-full bg-default">
        {shown.map((part) => (
          <span key={part.key} style={{ width: `${(breakdown[part.key] / scale) * 100}%`, backgroundColor: part.color }} />
        ))}
      </div>
      <ul aria-label="Context breakdown" className="flex flex-col">
        {shown.map((part) => (
          <li key={part.key} className="flex h-6 items-center gap-2 text-xs tabular-nums">
            <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: part.color }} />
            <span className="min-w-0 flex-1 truncate">{part.label}</span>
            <span className="text-muted">{formatTokens(breakdown[part.key])}</span>
            <span className="w-8 text-end text-muted">{Math.round((breakdown[part.key] / window) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
