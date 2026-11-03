// What the Terminal surface's tab row derives from the host's list (ADR-0040
// §5): which tab stays selected as terminals come and go, and which tabs fit
// in the row with the selected one always among them.
import type { TerminalId, TerminalInfo } from "@pinomad/protocol/terminals.ts";

/** A finished process's badge: its code, its signal, or neither when the host knew none. */
export function exitLabel(exit: NonNullable<TerminalInfo["exit"]>): string {
  if (exit.code !== null) return `exit ${exit.code}`;
  return exit.signal === undefined ? "exited" : `signal ${exit.signal}`;
}

/**
 * The selection once the list changes: the same tab while it exists, else the
 * one that took its place (the next, or the new last), else the first.
 */
export function selectionAfter(
  previous: readonly TerminalInfo[],
  next: readonly TerminalInfo[],
  selected: TerminalId | undefined,
): TerminalId | undefined {
  if (selected !== undefined && next.some((terminal) => terminal.id === selected)) return selected;
  const index = previous.findIndex((terminal) => terminal.id === selected);
  if (index === -1) return next[0]?.id;
  return next[Math.min(index, next.length - 1)]?.id;
}

/** What the surface remembers per owner between lists. */
export interface SelectionMemory {
  readonly selected?: TerminalId;
  /** Just opened: selected once the host's list has it. */
  readonly pending?: TerminalId;
  /** The list the selection was made against, for a closed tab's neighbour. */
  readonly seen: readonly TerminalInfo[];
}

/** The tab to show for `terminals`, and what to remember for the next list. */
export function resolveSelection(
  memory: SelectionMemory | undefined,
  terminals: readonly TerminalInfo[],
): { selected: TerminalId | undefined; memory: SelectionMemory } {
  const arrived = memory?.pending !== undefined && terminals.some((terminal) => terminal.id === memory.pending);
  const selected = arrived ? memory!.pending : selectionAfter(memory?.seen ?? [], terminals, memory?.selected);
  const pending = arrived ? undefined : memory?.pending;
  return {
    selected,
    memory: { ...(selected === undefined ? {} : { selected }), ...(pending === undefined ? {} : { pending }), seen: terminals },
  };
}

/** The first `fit` tabs in creation order, the selected one always among them; the rest go to the menu. */
export function partitionTabs(
  terminals: readonly TerminalInfo[],
  selected: TerminalId | undefined,
  fit: number,
): { inline: TerminalInfo[]; overflow: TerminalInfo[] } {
  const count = Math.max(fit, 1);
  const shown = new Set(terminals.slice(0, count).map((terminal) => terminal.id));
  if (selected !== undefined && !shown.has(selected) && terminals.some((terminal) => terminal.id === selected)) {
    // Give the selected tab the last inline slot.
    const last = terminals.slice(0, count).at(-1);
    if (last !== undefined) shown.delete(last.id);
    shown.add(selected);
  }
  return {
    inline: terminals.filter((terminal) => shown.has(terminal.id)),
    overflow: terminals.filter((terminal) => !shown.has(terminal.id)),
  };
}
