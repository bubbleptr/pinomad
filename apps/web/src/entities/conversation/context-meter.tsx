import type { ContextUsage } from "@pinomad/client/context-usage.ts";
import type { ContextBreakdown } from "@pinomad/protocol/presentation.ts";
import { Badge } from "../../shared/ui/badge.tsx";

/** A nearly-full window warns before the conversation compacts itself. */
const WARNING_PERCENT = 80;

/** Token counts as the meter reads them: one decimal below 100K ("4.2K", "88.0K"), whole above ("200K", "1M"). */
export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 100_000
      ? `${Math.round(tokens / 1000)}K`
      : tokens >= 1000
        ? `${(tokens / 1000).toFixed(1)}K`
        : `${Math.round(tokens)}`;

const percentOf = (usage: ContextUsage): number => Math.round((usage.used / usage.window) * 100);
const isWarning = (usage: ContextUsage | undefined): boolean => usage !== undefined && percentOf(usage) >= WARNING_PERCENT;

/**
 * A lighter step of a data color, for parts in one family: toward the card in
 * light, toward white in dark, where a step toward the card would sink into
 * the empty cells.
 */
const tint = (color: string, percent: number): string => `color-mix(in oklab, ${color} ${percent}%, light-dark(var(--card), #ffffff))`;

// The fixed overhead the host sends every request is one blue family, darkest
// first; MCP, the part servers add, is teal; messages, the part that grows,
// purple.
export const PARTS = [
  { key: "system", label: "System", color: "var(--data-blue)" },
  { key: "tools", label: "Tools", color: tint("var(--data-blue)", 60) },
  { key: "skills", label: "Skills", color: tint("var(--data-blue)", 30) },
  { key: "mcp", label: "MCP", color: "var(--data-teal)" },
  { key: "messages", label: "Messages", color: "var(--data-purple)" },
] as const;

/**
 * The section's headline: tokens used, of the window, and the share as a
 * badge that turns warning near compaction. `used` may exceed `window` after
 * a swap to a smaller model, and the share stays honest. Without a qualifying
 * reply it reads "—": the last usage predates a compaction or reset and would lie.
 */
export function ContextHeadline({ usage }: { usage: ContextUsage | undefined }) {
  if (usage === undefined) return <p className="py-1 text-2xl/8 font-medium text-muted-foreground">—</p>;
  return (
    <div className="flex items-center gap-2 py-1">
      <p className="min-w-0 flex-1 truncate tabular-nums">
        <span className="text-2xl/8 font-medium">{formatTokens(usage.used)}</span>{" "}
        <span className="text-sm text-muted-foreground">of {formatTokens(usage.window)} tokens</span>
      </p>
      <Badge variant={isWarning(usage) ? "warning" : "default"} className="tabular-nums">
        {percentOf(usage)}%
      </Badge>
    </div>
  );
}

/** The meter's grid: each cell is 1/160 of the window. */
const GRID_COLUMNS = 32;
export const GRID_CELLS = GRID_COLUMNS * 5;

/**
 * Cells per part on the window's scale, in the parts' order. Every part that
 * takes space gets at least one cell, so a 1M window still shows what fills a
 * short conversation; the grid is full only once the window is, and past it
 * the parts share the whole grid.
 */
export function allocateCells(tokens: readonly number[], usage: ContextUsage): number[] {
  const present = tokens.filter((count) => count > 0).length;
  if (present === 0) return tokens.map(() => 0);
  const target =
    usage.used >= usage.window
      ? GRID_CELLS
      : Math.max(present, Math.min(GRID_CELLS - 1, Math.round((usage.used / usage.window) * GRID_CELLS)));
  const total = tokens.reduce((sum, count) => sum + Math.max(0, count), 0);
  const quotas = tokens.map((count) => (count > 0 ? (count / total) * target : 0));
  const cells = quotas.map((quota) => (quota > 0 ? Math.max(1, Math.floor(quota)) : 0));
  let missing = target - cells.reduce((sum, count) => sum + count, 0);
  // Largest remainder hands out what flooring left; the one-cell minimum is paid back by the most over-served parts.
  while (missing !== 0) {
    let pick = -1;
    for (let index = 0; index < cells.length; index += 1) {
      if (quotas[index] === 0 || (missing < 0 && cells[index] <= 1)) continue;
      const gap = quotas[index] - cells[index];
      if (pick < 0 || (missing > 0 ? gap > quotas[pick] - cells[pick] : gap < quotas[pick] - cells[pick])) pick = index;
    }
    cells[pick] += Math.sign(missing);
    missing -= Math.sign(missing);
  }
  return cells;
}

/**
 * The context meter: a grid of cells on the window's scale. With the host's
 * breakdown of the reply it counts, one colour per part; without one (an
 * older host, or the reply not broken down yet) a single fill, warning-coloured
 * near compaction, so a breakdown arriving only colours the cells in.
 */
export function ContextBar({ usage, breakdown }: { usage: ContextUsage | undefined; breakdown: ContextBreakdown | undefined }) {
  const parts =
    usage === undefined
      ? []
      : breakdown === undefined
        ? [{ key: "used", tokens: usage.used, className: isWarning(usage) ? "bg-warning" : "bg-muted-foreground", color: undefined }]
        : PARTS.map((part) => ({ key: part.key, tokens: breakdown[part.key], className: undefined, color: part.color }));
  const counts = usage === undefined ? [] : allocateCells(parts.map((part) => part.tokens), usage);
  const filled = parts.flatMap((part, index) => Array.from({ length: counts[index] }, () => part));
  return (
    <div
      className="grid gap-0.5"
      style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
      {...(usage === undefined
        ? { "aria-label": "Context usage unknown" }
        : {
            role: "meter",
            "aria-label": `Context ${percentOf(usage)}% used, ${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens`,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.min(100, percentOf(usage)),
          })}
      data-testid="context-meter"
    >
      {Array.from({ length: GRID_CELLS }, (_, index) => {
        const part = filled[index];
        return (
          <span
            key={index}
            aria-hidden
            className={`aspect-square rounded-[1.5px] ${part === undefined ? "bg-default" : (part.className ?? "")}`}
            style={part?.color === undefined ? undefined : { backgroundColor: part.color }}
          />
        );
      })}
    </div>
  );
}
