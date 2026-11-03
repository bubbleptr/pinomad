// The Terminal surface (ADR-0040 §5, ADR-0041): the owner's terminals, one
// tab each, their screens drawn by xterm.js. The list follows the main
// column's conversation, but it belongs to the terminals' owner — the family
// root, or a pre-ADR-0019 fork with its own worktree — so moving between that
// owner's conversations keeps the selection and the screen. The client
// remembers each owner's last tab in memory.
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/Layout";
import { Tab, TabList, TabMenu } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteTerminals, TerminalsState } from "@pinomad/protocol/remote-durable.ts";
import type { TerminalId, TerminalInfo, TerminalList } from "@pinomad/protocol/terminals.ts";
import { exitLabel, partitionTabs, resolveSelection, type SelectionMemory } from "../../entities/terminal/terminal-tabs.ts";
import { MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "../../shared/ui/icons.tsx";
import { RenameTerminalDialog } from "./rename-terminal-dialog.tsx";
import { SurfaceBar } from "./surface-bar.tsx";

// Suspense doesn't catch a chunk that fails to load; this keeps the surface up.
const XtermView = lazy(() =>
  import("./xterm-view.tsx").catch(() => ({
    default: () => (
      <Text type="supporting" className="p-3">
        Couldn't load the terminal. Reload the page to try again.
      </Text>
    ),
  })),
);

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

  const tabs = list === undefined || list.terminals.length === 0 ? null : (
    <TerminalTabs list={list} selectedId={selectedId} onSelect={(id) => select(id)} />
  );
  const full = list !== undefined && list.terminals.length >= list.limit;
  // With no terminal yet, the body's New terminal button is the one way in.
  const actions =
    list === undefined || list.terminals.length === 0 ? null : (
      <>
        <IconButton
          icon={<Plus className="size-4" aria-hidden="true" />}
          label="New terminal"
          size="sm"
          variant="ghost"
          tooltip={full ? `Terminal limit reached (${list.limit})` : "New terminal"}
          isDisabled={!live || full}
          onClick={openTerminal}
        />
        {selected === undefined ? null : (
          <DropdownMenu
            hasChevron={false}
            button={{
              icon: <MoreHorizontal aria-hidden="true" />,
              isIconOnly: true,
              label: "Terminal actions",
              size: "sm",
              variant: "ghost",
              isDisabled: !live,
            }}
            items={[
              { label: "Rename…", icon: <Pencil aria-hidden="true" size={16} />, onClick: () => setRenaming(selected) },
              {
                label: "Restart",
                icon: <RefreshCw aria-hidden="true" size={16} />,
                onClick: () => run(terminals.restart(selected.id, { cols: selected.cols, rows: selected.rows })),
              },
              { label: "Close", icon: <Trash2 aria-hidden="true" size={16} />, onClick: () => run(terminals.close(selected.id)) },
            ]}
          />
        )}
      </>
    );

  return (
    <VStack className="h-full min-h-0" gap={0}>
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
        <div className="shrink-0 border-b border-border px-3 py-1 text-xs text-muted" role="status">
          Reconnecting…
        </div>
      ) : null}
      {error === undefined ? null : (
        <Text type="supporting" className="shrink-0 px-3 py-2" role="alert">
          {error}
        </Text>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {conversationId === undefined ? (
          <Message>Open a conversation to use its terminals.</Message>
        ) : state === undefined || state.kind === "loading" ? (
          <Message>Loading…</Message>
        ) : state.kind === "unavailable" ? (
          <Message>{state.reason}</Message>
        ) : selected === undefined ? (
          <div className="flex flex-1 items-center justify-center">
            <Button label="New terminal" variant="secondary" isDisabled={!live} onClick={openTerminal} />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1">
              <Suspense fallback={null}>
                <XtermView
                  key={selected.id}
                  terminals={terminals}
                  terminalId={selected.id}
                  enabled={live && selected.exit === undefined}
                />
              </Suspense>
            </div>
            {selected.exit === undefined ? null : (
              <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
                <Text type="supporting" className="min-w-0 flex-1">
                  {selected.exit.code === null ? "The process exited." : `The process exited with code ${selected.exit.code}.`}
                </Text>
                <Button
                  label="Restart"
                  variant="secondary"
                  size="sm"
                  isDisabled={!live}
                  onClick={() => run(terminals.restart(selected.id, { cols: selected.cols, rows: selected.rows }))}
                />
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
    </VStack>
  );
}

function Message({ children }: { children: ReactNode }) {
  return (
    <Text type="supporting" className="p-3">
      {children}
    </Text>
  );
}

/** Tabs in creation order; those that don't fit go to the menu, never the selected one. */
function TerminalTabs({
  list,
  selectedId,
  onSelect,
}: {
  list: TerminalList;
  selectedId: TerminalId | undefined;
  onSelect: (id: TerminalId) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const fit = useFittingTabs(
    row,
    list.terminals.length,
    list.terminals.map((terminal) => `${terminal.name}\u0000${terminal.exit === undefined ? "" : exitLabel(terminal.exit)}`).join("\u0001"),
  );
  const { inline, overflow } = partitionTabs(list.terminals, selectedId, fit);
  return (
    <div ref={row} className="min-w-0 flex-1 overflow-hidden">
      <TabList size="sm" value={selectedId ?? ""} onChange={onSelect}>
        {inline.map((terminal) => (
          <Tab
            key={terminal.id}
            value={terminal.id}
            label={terminal.name}
            className={terminal.exit === undefined ? "pinomad-terminal-tab" : "pinomad-terminal-tab text-muted"}
            endContent={
              terminal.exit === undefined ? undefined : <span className="text-xs text-muted">{exitLabel(terminal.exit)}</span>
            }
          />
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
  );
}
