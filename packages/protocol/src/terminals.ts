// Interactive terminals the host runs for a conversation family (5.27,
// ADR-0040 §5, ADR-0041). A terminal belongs to its owner — the family's
// root, or a pre-ADR-0019 fork with its own worktree — and every conversation
// of that owner sees the same list.
import type { ConversationId } from "@earendil-works/pi-durable";

/** Host-generated and random: there is no per-device scoping to hide behind. */
export type TerminalId = string;

export interface TerminalInfo {
  readonly id: TerminalId;
  /** The rename if there is one, else the shell's last window title, else `Terminal N`. */
  readonly name: string;
  /** Whether `name` is a rename, which the shell's title no longer changes. */
  readonly renamed: boolean;
  /** The pty's size now: the last device that typed or resized sets it. */
  readonly cols: number;
  readonly rows: number;
  /** Present once the process exited; the entry stays until it is closed or restarted. */
  readonly exit?: { readonly code: number | null; readonly signal?: number };
}

/** The `terminals:<conversationId>` stream's value. */
export interface TerminalList {
  readonly owner: ConversationId;
  /** How many terminals an owner may have, exited ones included. */
  readonly limit: number;
  /** In creation order. */
  readonly terminals: readonly TerminalInfo[];
}

/** `hello.terminals`: absent when the host's pty module didn't load. */
export interface TerminalsHello {
  readonly limit: number;
}

export function isTerminalsHello(value: unknown): value is TerminalsHello {
  return value !== null && typeof value === "object" && typeof (value as { limit?: unknown }).limit === "number";
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export const terminalsStream = (id: ConversationId) => `terminals:${id}` as const;
export const terminalStream = (id: TerminalId) => `terminal:${id}` as const;
