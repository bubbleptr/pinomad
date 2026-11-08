// Background-process derivations (ADR-0045), shared by every client. The
// list is the family root's `pinomad.processes` document; clients never
// remember process objects themselves. DOM-free.
import { classify } from "@pinomad/protocol/presentation.ts";
import { isProcessActive, type ProcessInfo, type ProcessState } from "@pinomad/protocol/processes.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";

/** The family's processes from its `pinomad.processes` document, in host order. */
export function processesOf(docs: readonly ExtensionDocView[]): ProcessInfo[] {
  // A malformed document falls back; a later valid one is the root's current
  // value, so it wins (docs arrive in host order).
  let processes: readonly ProcessInfo[] = [];
  for (const doc of docs) {
    const classified = classify(doc.presentation, doc.value);
    if (classified.type === "pinomad.processes") processes = classified.value.processes;
  }
  return [...processes];
}

/** The entries that still count against the family limit and can be stopped. */
export function activeProcesses(docs: readonly ExtensionDocView[]): ProcessInfo[] {
  return processesOf(docs).filter((process) => isProcessActive(process.state));
}

/** The exit code when the state carries one; `null` for a signal death. */
export function processExitCode(state: ProcessState): number | null | undefined {
  return typeof state === "object" && "exited" in state ? state.exited : undefined;
}

/** A one-line state for lists and headers. */
export function processStatusText(state: ProcessState): string {
  if (state === "starting") return "Starting";
  if (state === "running") return "Running";
  if (state === "lost") return "Lost track after a host restart; it may still be running";
  if (typeof state === "object" && "stopped" in state) {
    switch (state.stopped) {
      case "agent":
        return "Stopped by the agent";
      case "user":
        return "Stopped by the user";
      case "archive":
        return "Stopped when the conversation was archived";
      case "shutdown":
        return "Stopped when the host shut down";
    }
  }
  if (typeof state === "object" && "failed" in state) return `Failed to start: ${state.failed}`;
  if (typeof state === "object" && "exited" in state) {
    if (state.signal !== undefined) return `Exited after signal ${state.signal}`;
    if (state.exited === null) return "Exited";
    return `Exited with code ${state.exited}`;
  }
  return "Unknown";
}
