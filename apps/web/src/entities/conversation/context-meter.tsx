import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { ContextUsage } from "@pinomad/client/context-usage.ts";

/** A nearly-full window warns before the conversation compacts itself. */
const WARNING_PERCENT = 80;

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : `${Math.round(tokens)}`;

/** Spend to the cent; a fraction of a cent still reads as spent. */
export const formatCost = (cost: number): string => (cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`);

// r=6 inside a 16px viewBox: the ring stands as tall as the row's size-4 icons.
const CIRCUMFERENCE = 2 * Math.PI * 6;

/**
 * The overview card's context meter: a ring filling toward the model's
 * window plus the percent in figures, the token counts in its tooltip.
 * `used` may exceed `window` after a swap to a smaller model — the text
 * reports the honest number while the ring saturates at full. Without a
 * qualifying reply the meter reads "—": the last usage predates a
 * compaction/reset and would lie.
 */
export function ContextMeter({ usage }: { usage: ContextUsage | undefined }) {
  const percent = usage === undefined ? undefined : Math.round((usage.used / usage.window) * 100);
  const warning = percent !== undefined && percent >= WARNING_PERCENT;
  const text = percent === undefined ? "—" : `${percent}%`;
  const label =
    usage === undefined
      ? "Context usage unknown"
      : `Context ${percent}% used, ${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens`;
  const tooltip = usage === undefined ? "No usage data yet" : `${formatTokens(usage.used)} / ${formatTokens(usage.window)}`;
  const fill = usage === undefined ? 0 : Math.min(1, usage.used / usage.window);
  return (
    // `alignment="end"` keeps the tooltip inside the viewport: the meter
    // sits at the card's right edge, where a centered one clips.
    <Tooltip content={tooltip} placement="above" alignment="end">
      <span
        className={`inline-flex h-7 items-center gap-1.5 px-1 text-xs ${warning ? "text-warning" : "text-muted"}`}
        {...(percent === undefined
          ? { "aria-label": label }
          : {
              role: "meter",
              "aria-label": label,
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": Math.min(100, percent),
            })}
        tabIndex={0}
        data-testid="context-meter"
      >
        <svg aria-hidden="true" className="size-4 -rotate-90" viewBox="0 0 16 16">
          {/* Track at quarter opacity of the same ink: a visible ring reads
              "gauge" where a faint one plus a round-cap arc reads "spinner". */}
          <circle className="stroke-current opacity-25" cx="8" cy="8" fill="none" r="6" strokeWidth="2" />
          <circle
            className="stroke-current"
            cx="8"
            cy="8"
            fill="none"
            r="6"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fill)}
            strokeWidth="2"
          />
        </svg>
        <span className="tabular-nums">{text}</span>
      </span>
    </Tooltip>
  );
}
