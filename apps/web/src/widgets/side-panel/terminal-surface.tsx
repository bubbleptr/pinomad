// The Terminal surface (ADR-0040 §5, ADR-0041): the owner's terminals, one
// tab each, their screens drawn by xterm.js. The list follows the main
// column's conversation, but it belongs to the terminals' owner — the family
// root, or a pre-ADR-0019 fork with its own worktree — so moving between that
// owner's conversations keeps the selection and the screen. The client
// remembers each owner's last tab in memory.
import { Button } from "../../shared/ui/button.tsx";
import { ContextMenu, type ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { Tab, TabList, TabMenu } from "@astryxdesign/core/TabList";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteTerminals, TerminalsState } from "@pinomad/protocol/remote-durable.ts";
import type { TerminalId, TerminalInfo, TerminalList } from "@pinomad/protocol/terminals.ts";
import { exitLabel, partitionTabs, resolveSelection, type SelectionMemory } from "../../entities/terminal/terminal-tabs.ts";
import { Cancel, Pencil, Plus, RefreshCw, Trash2 } from "../../shared/ui/icons.tsx";
import { LazyXtermView } from "./lazy-xterm-view.tsx";
import { RenameTerminalDialog } from "./rename-terminal-dialog.tsx";
import { SurfaceBar } from "./surface-bar.tsx";
import { TerminalIllustration } from "./terminal-illustration.tsx";

/** A new terminal's size until its screen is fitted; the screen resizes it at once. */
const OPEN_SIZE = { cols: 80, rows: 24 };

/** Each owner's selection, per client: a host restart's ids never collide with another host's. */
const selections = new WeakMap<object, Map<ConversationId, SelectionMemory>>();

function memoryOf(terminals: object): Map<ConversationId, SelectionMemory> {
  let memory = selections.get(terminals);
  if (memory === undefined) selections.set(terminals, (memory = new Map()));
  return memory;
}

/**
 * The shown conversation's list. Moving to another conversation keeps the
 * last list until the next one lands: within one owner it is the same list,
 * and the screen must not unmount and replay in between. Until then it is
 * not `confirmed`: another owner's terminals may still be on screen.
 */
function useTerminalsState(
  terminals: RemoteTerminals,
  conversationId: ConversationId | undefined,
): { state: TerminalsState | undefined; confirmed: boolean } {
  const [shown, setShown] = useState<{ conversationId: ConversationId; state: TerminalsState }>();
  useEffect(() => {
    if (conversationId === undefined) return;
    return terminals.watch(conversationId, (next) =>
      setShown((previous) => (next.kind === "loading" && previous?.state.kind === "ready" ? previous : { conversationId, state: next })),
    );
  }, [terminals, conversationId]);
  if (conversationId === undefined) return { state: undefined, confirmed: false };
  return { state: shown?.state, confirmed: shown?.conversationId === conversationId };
}

/**
 * How many tabs fit before the row overflows: start from all of them and drop
 * one per layout pass until the row fits. A wider row or new labels (a
 * shell's new title) start over; tabs that change size on their own (styles
 * arriving after the first measure) are measured again.
 */
function useFittingTabs(row: RefObject<HTMLDivElement | null>, count: number, labels: string): number {
  const [width, setWidth] = useState(0);
  const key = `${count}\u0000${width}\u0000${labels}`;
  const [state, setState] = useState({ key, fit: count });
  const [, remeasure] = useState(0);
  const fit = state.key === key ? state.fit : count;
  useLayoutEffect(() => {
    const element = row.current;
    if (element !== null && element.scrollWidth > element.clientWidth && fit > 1) setState({ key, fit: fit - 1 });
  });
  useEffect(() => {
    const element = row.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      remeasure((n) => n + 1);
    });
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [row]);
  return fit;
}

export function TerminalSurface({
  terminals,
  conversationId,
  connected,
  stacked,
  barStart,
  barEnd,
}: {
  terminals: RemoteTerminals;
  /** The main column's loaded conversation; undefined while drafting. */
  conversationId: ConversationId | undefined;
  connected: boolean;
  /** The phone dialog: its switch and close button take the first row, the tabs the second. */
  stacked: boolean;
  barStart?: ReactNode;
  barEnd?: ReactNode;
}) {
  const { state, confirmed } = useTerminalsState(terminals, conversationId);
  const list = state?.kind === "ready" ? state.list : undefined;
  // Keys and actions wait for the list to be this conversation's owner's.
  const live = connected && confirmed;
  const [, rerender] = useState(0);
  const [renaming, setRenaming] = useState<TerminalInfo>();
  const [error, setError] = useState<string>();

  const memory = memoryOf(terminals);
  const read = list === undefined ? undefined : memory.get(list.owner);
  const resolved = list === undefined ? undefined : resolveSelection(read, list.terminals);
  useEffect(() => {
    // A click since this render replaced the entry; this render's answer is stale.
    if (list !== undefined && resolved !== undefined && memory.get(list.owner) === read) memory.set(list.owner, resolved.memory);
  });
  const selectedId = resolved?.selected;
  const selected = list?.terminals.find((terminal) => terminal.id === selectedId);

  const select = (id: TerminalId, pending = false): void => {
    if (list === undefined) return;
    memory.set(list.owner, { ...(pending ? { selected: selectedId, pending: id } : { selected: id }), seen: list.terminals });
    rerender((n) => n + 1);
  };
  const run = (action: Promise<unknown>): void => {
    setError(undefined);
    action.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const openTerminal = (): void => {
    if (conversationId === undefined) return;
    setError(undefined);
    terminals.open(conversationId, OPEN_SIZE).then(
      (id) => select(id, true),
      (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  const restart = (terminal: TerminalInfo): void =>
    run(terminals.restart(terminal.id, { cols: terminal.cols, rows: terminal.rows }));
  const close = (terminal: TerminalInfo): void => run(terminals.close(terminal.id));
  const full = list !== undefined && list.terminals.length >= list.limit;
  const tabs = list === undefined || list.terminals.length === 0 ? null : (
    <TerminalTabs
      list={list}
      selectedId={selectedId}
      live={live}
      onSelect={(id) => select(id)}
      onRename={setRenaming}
      onRestart={restart}
      onClose={close}
      onNew={full ? undefined : openTerminal}
    />
  );
  // With no terminal yet, the body's New terminal button is the one way in.
  const actions =
    list === undefined || list.terminals.length === 0 ? null : (
        <IconButton
          icon={<Plus className="size-4" aria-hidden="true" />}
          label="New terminal"
          size="sm"
          variant="ghost"
          tooltip={full ? `Terminal limit reached (${list.limit})` : "New terminal"}
          disabled={!live || full}
          onClick={openTerminal}
        />
    );

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {stacked ? (
        <>
          <SurfaceBar start={barStart} end={barEnd}>
            {null}
          </SurfaceBar>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
            <div className="flex min-w-0 flex-1 items-center">{tabs}</div>
            {actions}
          </div>
        </>
      ) : (
        <SurfaceBar
          start={barStart}
          end={
            <>
              {actions}
              {barEnd}
            </>
          }
        >
          {tabs}
        </SurfaceBar>
      )}
      {!connected && list !== undefined ? (
        <div className="shrink-0 border-b border-border px-3 py-1 text-xs text-muted-foreground" role="status">
          Reconnecting…
        </div>
      ) : null}
      {error === undefined ? null : (
        <span className="text-xs/5 text-muted-foreground shrink-0 px-3 py-2" role="alert">
          {error}
        </span>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {conversationId === undefined ? (
          <Message>Open a conversation to use its terminals.</Message>
        ) : state === undefined || state.kind === "loading" ? (
          <Message>Loading…</Message>
        ) : state.kind === "unavailable" ? (
          <Message>{state.reason}</Message>
        ) : selected === undefined ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="flex flex-col items-center gap-5">
              <TerminalIllustration />
              <Button variant="secondary" disabled={!live} onClick={openTerminal}>New terminal</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1">
              <Suspense fallback={null}>
                <LazyXtermView
                  key={selected.id}
                  terminals={terminals}
                  terminalId={selected.id}
                  enabled={live && selected.exit === undefined}
                />
              </Suspense>
            </div>
            {selected.exit === undefined ? null : (
              <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
                <span className="text-xs/5 text-muted-foreground min-w-0 flex-1">
                  {selected.exit.code === null ? "The process exited." : `The process exited with code ${selected.exit.code}.`}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!live}
                  onClick={() => restart(selected)}
                >
                  Restart
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {renaming === undefined ? null : (
        <RenameTerminalDialog
          terminal={renaming}
          terminals={terminals}
          connected={live}
          onClose={() => setRenaming(undefined)}
        />
      )}
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs/5 text-muted-foreground p-3">
      {children}
    </span>
  );
}

/**
 * Tabs in creation order; those that don't fit go to the menu, never the
 * selected one. Each tab has its own close button beside it (not inside: the
 * tab is a button too) and a context menu with the rest of its actions.
 */
function TerminalTabs({
  list,
  selectedId,
  live,
  onSelect,
  onRename,
  onRestart,
  onClose,
  onNew,
}: {
  list: TerminalList;
  selectedId: TerminalId | undefined;
  /** Off while the list may still be another owner's: no actions. */
  live: boolean;
  onSelect: (id: TerminalId) => void;
  onRename: (terminal: TerminalInfo) => void;
  onRestart: (terminal: TerminalInfo) => void;
  onClose: (terminal: TerminalInfo) => void;
  /** Undefined at the host's limit. */
  onNew: (() => void) | undefined;
}) {
  const row = useRef<HTMLDivElement>(null);
  // The tab the context menu acts on: the one under the pointer when it went
  // down (right click, long press), or the focused one for the menu key.
  const [target, setTarget] = useState<TerminalInfo>();
  const fit = useFittingTabs(
    row,
    list.terminals.length,
    list.terminals.map((terminal) => `${terminal.name}\u0000${terminal.exit === undefined ? "" : exitLabel(terminal.exit)}`).join("\u0001"),
  );
  const { inline, overflow } = partitionTabs(list.terminals, selectedId, fit);
  const aim = (event: { target: EventTarget }): void => {
    // The open menu sits inside the same trigger; pressing one of its items
    // chooses an action for the current target, it doesn't aim at a new one.
    if (!(event.target instanceof Element) || row.current?.contains(event.target) !== true) return;
    const value = event.target.closest("[data-tab-value]")?.getAttribute("data-tab-value");
    setTarget(list.terminals.find((terminal) => terminal.id === value));
  };
  const items: ContextMenuOption[] =
    target === undefined
      ? [{ label: "New terminal", icon: <Plus aria-hidden="true" size={16} />, isDisabled: onNew === undefined, onClick: () => onNew?.() }]
      : [
          { label: "Rename", icon: <Pencil aria-hidden="true" size={16} />, onClick: () => onRename(target) },
          { label: "Restart", icon: <RefreshCw aria-hidden="true" size={16} />, onClick: () => onRestart(target) },
          { type: "divider" },
          { label: "Close", icon: <Trash2 aria-hidden="true" size={16} />, onClick: () => onClose(target) },
        ];
  return (
    <div className="min-w-0 flex-1" onPointerDownCapture={aim} onContextMenuCapture={aim}>
      <ContextMenu label="Terminal actions" size="sm" items={items} isDisabled={!live}>
        <div ref={row} className="overflow-hidden">
          <TabList size="sm" value={selectedId ?? ""} onChange={onSelect}>
            {inline.map((terminal) => (
              <span key={terminal.id} className="pinomad-terminal-tab-slot group">
                <Tab
                  value={terminal.id}
                  label={terminal.name}
                  className={terminal.exit === undefined ? "pinomad-terminal-tab" : "pinomad-terminal-tab text-muted-foreground"}
                  onAuxClick={(event) => {
                    if (event.button === 1 && live) onClose(terminal);
                  }}
                  endContent={
                    terminal.exit === undefined ? undefined : <span className="text-xs text-muted-foreground">{exitLabel(terminal.exit)}</span>
                  }
                />
                <IconButton
                  icon={<Cancel className="size-3.5" aria-hidden="true" />}
                  label={`Close ${terminal.name}`}
                  size="sm"
                  variant="ghost"
                  tabIndex={-1}
                  disabled={!live}
                  className={
                    terminal.id === selectedId
                      ? "pinomad-terminal-tab-close"
                      : "pinomad-terminal-tab-close opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }
                  onClick={() => onClose(terminal)}
                />
              </span>
            ))}
            {overflow.length === 0 ? null : (
              <TabMenu
                label={`${overflow.length} more`}
                options={overflow.map((terminal) => ({
                  value: terminal.id,
                  label: terminal.exit === undefined ? terminal.name : `${terminal.name} (${exitLabel(terminal.exit)})`,
                }))}
              />
            )}
          </TabList>
        </div>
      </ContextMenu>
    </div>
  );
}
