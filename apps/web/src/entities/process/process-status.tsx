import type { ProcessState } from "@pinomad/protocol/processes.ts";
import { useNow } from "../../shared/use-now.ts";
import type { TaskTone } from "../conversation/task-glyph.tsx";

/** A clean exit or a stop is over; a non-zero exit, a failed start or a lost pty failed. */
export function processTone(state: ProcessState): TaskTone {
  if (state === "starting" || state === "running") return "running";
  if (state === "lost") return "failed";
  if (typeof state === "object" && "failed" in state) return "failed";
  if (typeof state === "object" && "exited" in state) {
    return state.signal === undefined && state.exited === 0 ? "done" : "failed";
  }
  return "done";
}

/** A few words for a row: "Running", "Exited 1", "Stopped", "Lost track". */
export function processShortText(state: ProcessState): string {
  if (state === "starting") return "Starting";
  if (state === "running") return "Running";
  if (state === "lost") return "Lost track";
  if (typeof state === "object" && "failed" in state) return "Failed to start";
  if (typeof state === "object" && "stopped" in state) return "Stopped";
  if (state.signal !== undefined) return `Exited (${state.signal})`;
  return state.exited === null ? "Exited" : `Exited ${state.exited}`;
}

/** "12s" under a minute, otherwise "1m 5s": the tasks' whole-second clock. */
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** How long a live process has been running, ticking each second. */
export function ProcessDuration({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return <>{elapsedText(now - startedAt)}</>;
}
