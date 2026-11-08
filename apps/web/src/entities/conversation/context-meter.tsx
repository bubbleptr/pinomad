import type { ContextUsage } from "@pinomad/client/context-usage.ts";
import type { ContextBreakdown } from "@pinomad/protocol/presentation.ts";

/** A nearly-full window warns before the conversation compacts itself. */
const WARNING_PERCENT = 80;

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : `${Math.round(tokens)}`;

/** Spend to the cent; a fraction of a cent still reads as spent. */
export const formatCost = (cost: number): string => (cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`);

const percentOf = (usage: ContextUsage): number => Math.round((usage.used / usage.window) * 100);
const isWarning = (usage: ContextUsage | undefined): boolean => usage !== undefined && percentOf(usage) >= WARNING_PERCENT;

// The app's categorical data palette (styles.css), even in lightness across
// themes. Messages take blue: the part the user produces and the one that grows.
export const PARTS = [
  { key: "system", label: "System", color: "var(--pigui-data-slate)" },
  { key: "skills", label: "Skills", color: "var(--pigui-data-amber)" },
  { key: "tools", label: "Tools", color: "var(--pigui-data-green)" },
  { key: "mcp", label: "MCP", color: "var(--pigui-data-orange)" },
  { key: "messages", label: "Messages", color: "var(--pigui-data-blue)" },
] as const;

/**
 * The context row's figures: share, then used / window. `used` may exceed
 * `window` after a swap to a smaller model — the share stays honest. Without
 * a qualifying reply it reads "—": the last usage predates a compaction or
 * reset and would lie.
 */
export function ContextFigures({ usage }: { usage: ContextUsage | undefined }) {
  return (
    <span className={isWarning(usage) ? "text-warning" : "text-muted"}>
      {usage === undefined ? "—" : `${percentOf(usage)}% · ${formatTokens(usage.used)} / ${formatTokens(usage.window)}`}
    </span>
  );
}

/**
 * The context meter: a bar on the window's scale. With the host's breakdown
 * of the reply it counts, one segment per part; without one (an older host,
 * or the reply not broken down yet) a single fill, warning-coloured near
 * compaction — so a breakdown arriving only colours the bar in and the row
 * never changes shape. Past the window it scales to the total.
 */
export function ContextBar({ usage, breakdown }: { usage: ContextUsage | undefined; breakdown: ContextBreakdown | undefined }) {
  const segments =
    usage === undefined
      ? []
      : breakdown === undefined
        ? [{ key: "used", tokens: usage.used, className: isWarning(usage) ? "bg-warning" : "bg-muted", color: undefined }]
        : PARTS.filter((part) => breakdown[part.key] > 0).map((part) => ({
            key: part.key,
            tokens: breakdown[part.key],
            className: undefined,
            color: part.color,
          }));
  const scale = usage === undefined ? 1 : Math.max(usage.window, usage.used);
  return (
    <div
      className="flex h-1.5 gap-px overflow-hidden rounded-full bg-default"
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
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={segment.className}
          style={{ width: `${(segment.tokens / scale) * 100}%`, ...(segment.color === undefined ? {} : { backgroundColor: segment.color }) }}
        />
      ))}
    </div>
  );
}
