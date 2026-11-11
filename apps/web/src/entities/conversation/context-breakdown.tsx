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
 * The meter's legend: a row per part that takes space, with its tokens, then
 * what is left of the window (the empty cells). Without a breakdown only the
 * left row shows.
 */
export function ContextBreakdownList({ usage, breakdown }: { usage: ContextUsage; breakdown: ContextBreakdown | undefined }) {
  const rows = [
    ...(breakdown === undefined
      ? []
      : PARTS.filter((part) => breakdown[part.key] > 0).map((part) => ({
          key: part.key,
          label: part.label,
          tokens: breakdown[part.key],
          swatch: { backgroundColor: part.color },
        }))),
    ...(usage.used < usage.window ? [{ key: "left", label: "Left", tokens: usage.window - usage.used, swatch: undefined }] : []),
  ];
  return (
    <ul aria-label="Context breakdown" className="flex flex-col pb-1">
      {rows.map((row) => (
        <li key={row.key} className="flex h-6 items-center gap-2 text-xs tabular-nums">
          <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${row.swatch === undefined ? "bg-default" : ""}`} style={row.swatch} />
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="text-muted-foreground">{formatTokens(row.tokens)}</span>
        </li>
      ))}
    </ul>
  );
}
