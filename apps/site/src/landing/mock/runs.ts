// A subagent run in the hero mock, and where it stands on the mock's clock.
//
// The clock counts seconds since the hero came into view (0 when prerendered, and
// for good under reduced motion). A run that is still going ticks with it until
// `finishesIn`, then shows as done, so a page left open doesn't look stuck.

export type Model = "claude" | "openai" | "deepseek" | "qwen";

export type Run = {
  title: string;
  agent: string;
  model: Model;
  /** The full model id, as the card's meta line shows it. */
  modelId: string;
  /** What it is doing while it runs: a tool and its target. */
  activity?: string;
  /** Seconds it had been running when the clock started; its total if `done`. */
  since: number;
  done?: boolean;
  /** Clock seconds after which it finishes. */
  finishesIn?: number;
};

export type RunState = { status: "running" | "done"; seconds: number };

export function runAt(run: Run, clock: number): RunState {
  if (run.done) return { status: "done", seconds: run.since };
  if (run.finishesIn !== undefined && clock >= run.finishesIn) {
    return { status: "done", seconds: run.since + run.finishesIn };
  }
  return { status: "running", seconds: run.since + clock };
}

/** "12s" under a minute, otherwise "1m 5s" — the web client's format. */
export function elapsedText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** "13.6s", "1m 4.3s": the live step's clock, to a tenth as the client shows it. */
export function clockText(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10)) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)}s`;
  return `${Math.floor(tenths / 60)}m ${(tenths % 60).toFixed(1)}s`;
}
