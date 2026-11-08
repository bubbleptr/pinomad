// Background processes the host runs for a conversation family (5.31,
// ADR-0045). They live in host memory only; the list is the family root's
// `pinomad.processes` document, and output is streamed at raw positions.
import type { ConversationId } from "@earendil-works/pi-durable";

/** Host-generated and random: there is no per-device scoping to hide behind. */
export type ProcessId = string;

export type ProcessStopReason = "agent" | "user" | "archive" | "shutdown";

export type ProcessExited = {
  readonly exited: number | null;
  readonly signal?: string;
}

export type ProcessStopped = {
  readonly stopped: ProcessStopReason;
}

export type ProcessFailed = {
  readonly failed: string;
}

/**
 * `starting` and `running` are live; the rest are terminal. `lost` means the
 * previous host never finished with it — the process may still be running,
 * but this host no longer tracks it and never signals its old pid.
 */
export type ProcessState =
  | "starting"
  | "running"
  | ProcessExited
  | ProcessStopped
  | ProcessFailed
  | "lost";

/** One entry of the root family's `pinomad.processes` document. */
export type ProcessInfo = {
  readonly id: ProcessId;
  /** The conversation that started it; its execution checkout is the working directory. */
  readonly owner: ConversationId;
  readonly name: string;
  readonly command: string;
  readonly pid?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: ProcessState;
}

/** The `pinomad.processes` document, on the family root. */
export type ProcessesState = {
  readonly processes: readonly ProcessInfo[];
}

/** `hello.processes`: absent when the host's pty module didn't load. */
export interface ProcessesHello {
  readonly limit: number;
}

export function isProcessesHello(value: unknown): value is ProcessesHello {
  return value !== null && typeof value === "object" && typeof (value as { limit?: unknown }).limit === "number";
}

/** Whether the entry still counts against the family limit and delays idle upgrades. */
export function isProcessActive(state: ProcessState): boolean {
  return state === "starting" || state === "running";
}

/** `process_output` / `stopProcess`: text after a raw `since`, stripped of ANSI only for display. */
export interface ProcessOutput {
  readonly text: string;
  /** The raw output position after `text`; pass it back as `since`. */
  readonly next: number;
  /** `since` was older than the retained output, so the beginning is missing. */
  readonly truncated: boolean;
  readonly status: ProcessState;
  /** The exit code when `status` is `exited`; `null` means it died by signal. */
  readonly exitCode?: number | null;
}

export const processStream = (id: ProcessId) => `process:${id}` as const;
