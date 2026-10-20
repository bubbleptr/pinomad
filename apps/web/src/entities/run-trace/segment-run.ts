// A run's steps cut at Interim Output (ADR-0026 §2): what the model said to
// the user is prose; the tool calls and thinking between two such passages
// fold into one trace row. Presentation only — the derived step list is
// unchanged, so each client segments it its own way.
import type { CotStep } from "@pinomad/client/cot-view.ts";
import type { ToolItem } from "@pinomad/client/tool-item.ts";

export type TraceStep = Exclude<CotStep, { kind: "interim" }>;

export type RunSegment =
  | { kind: "interim"; key: string; text: string }
  | {
      kind: "trace";
      key: string;
      /** Thinking and tool steps in Turn order, as the expanded row lists them. */
      steps: TraceStep[];
      /** The calls the row's summary counts: every call except a `todo_write` that landed. */
      counted: ToolItem[];
      /** A step in it is still streaming or executing. */
      live: boolean;
    };

/**
 * A todo write that landed is on the todo card, so the row does not count it
 * again. One that failed (or has not finished) changed nothing there: the
 * row is the only place it shows, so it counts like any other call.
 */
function reportedByTodoCard(tool: ToolItem) {
  return tool.toolName === "todo_write" && tool.state === "output-available";
}

export function segmentRun(steps: readonly CotStep[]): RunSegment[] {
  const segments: RunSegment[] = [];
  let trace: Extract<RunSegment, { kind: "trace" }> | undefined;

  for (const step of steps) {
    if (step.kind === "interim") {
      trace = undefined;
      segments.push({ kind: "interim", key: `segment-${segments.length}`, text: step.text });
      continue;
    }
    if (trace === undefined) {
      trace = { kind: "trace", key: `segment-${segments.length}`, steps: [], counted: [], live: false };
      segments.push(trace);
    }
    trace.steps.push(step);
    trace.live ||= step.live;
    if (step.kind === "tools") {
      trace.counted.push(...step.tools.filter((tool) => !reportedByTodoCard(tool)));
    }
  }

  return segments;
}
