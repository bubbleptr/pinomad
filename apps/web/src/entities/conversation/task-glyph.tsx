import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { Bot, CommandLine } from "../../shared/ui/icons.tsx";

/** Where a task stands: still at work (or waiting on an answer), failed, or over. */
export type TaskTone = "running" | "failed" | "done";

const TONE_CLASS: Record<TaskTone, string> = {
  running: "text-success",
  failed: "text-destructive",
  done: "text-muted-foreground",
};

/** A subagent's tone; one with no status has finished. */
export function subagentTone(status: ConversationSummary["status"]): TaskTone {
  if (status === "failed") return "failed";
  return status === undefined ? "done" : "running";
}

/**
 * A task row's glyph: the icon says which kind of task it is (a subagent or a
 * background process), the color where it stands. Decorative: the row names
 * it (a list row in words, an Overview row through its icon label).
 */
export function TaskGlyph({ kind, tone }: { kind: "subagent" | "process"; tone: TaskTone }) {
  const Icon = kind === "subagent" ? Bot : CommandLine;
  return (
    <span
      data-slot="task-glyph"
      data-kind={kind}
      data-tone={tone}
      aria-hidden="true"
      className={`flex size-4 shrink-0 items-center justify-center ${TONE_CLASS[tone]}`}
    >
      <Icon className="size-4" />
    </span>
  );
}
