// The right-side panel holds fixed surfaces (ADR-0040), switched from their
// icons at the right of the chat header. Each surface owns the panel's first
// row, level with that header, for its status and actions. Tasks is the
// family's subagents grouped by owner (ADR-0047 §1), opening their transcript
// via `view.side`, next to its background processes.
// Changes is the shown conversation's checkout diff (changes-surface.tsx);
// Terminal is the terminals' owner's shells (terminal-surface.tsx). Plugin
// panels follow the built-in surfaces (ADR-0049).
import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogContent } from "@/shared/ui/dialog";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { useErrorToast } from "../../shared/ui/toast.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../../shared/ui/item.tsx";
import { ResizeHandle, useResizableWidth } from "../../shared/ui/resize-handle.tsx";
import { Suspense, useEffect, useId, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { ProcessListState, RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isProcessActive, type ProcessId, type ProcessInfo, type ProcessState } from "@pinomad/protocol/processes.ts";
import type { ConversationSummary, DurableView, SideConversationView } from "@pinomad/protocol/view.ts";
import { forksAt, relativeTime, rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { canStopSubagent, conversationName } from "../../entities/conversation/subagent.ts";
import { orderedProcesses, processStatusText } from "@pinomad/client/processes.ts";
import { useNow } from "../../shared/use-now.ts";
import { taskTally } from "../../entities/conversation/task-tally.ts";
import { subagentTone, TaskGlyph } from "../../entities/conversation/task-glyph.tsx";
import { agoText, orderedSubagents } from "../../entities/conversation/task-order.ts";
import { processShortText, processTone } from "../../entities/process/process-status.tsx";
import { useProcessList } from "../../entities/process/use-process-list.ts";
import { AnimatedSidebarRight } from "../../shared/ui/animated-icons.tsx";
import { ArrowLeft, Bot, Cancel, CommandLine, FileDiff, Puzzle } from "../../shared/ui/icons.tsx";
import type { PluginPanel, PluginSurfaceId } from "../../entities/plugin/load-plugins.ts";
import { PluginScope, PluginSlot } from "../../entities/plugin/plugin-host.tsx";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";
import { ConversationTranscript } from "../chat/conversation-transcript.tsx";
import { ConversationSkeleton } from "../chat/conversation-skeleton.tsx";
import { ChangesSurface } from "./changes-surface.tsx";
import { LazyXtermView } from "./lazy-xterm-view.tsx";
import { SurfaceBar } from "./surface-bar.tsx";
import { TerminalSurface } from "./terminal-surface.tsx";
import { StatusDot } from "../../shared/ui/status-dot.tsx";

type BuiltInSurface = "tasks" | "changes" | "terminal";
export type PanelSurface = BuiltInSurface | PluginSurfaceId;

const SURFACES: readonly { readonly id: BuiltInSurface; readonly label: string; readonly icon: ReactNode }[] = [
  { id: "tasks", label: "Tasks", icon: <Bot className="size-4" aria-hidden="true" /> },
  { id: "changes", label: "Changes", icon: <FileDiff className="size-4" aria-hidden="true" /> },
  { id: "terminal", label: "Terminal", icon: <CommandLine className="size-4" aria-hidden="true" /> },
];

/**
 * A stored surface id, or Tasks when it names none of today's surfaces. A
 * plugin surface is kept as stored: plugins load after this runs, and
 * `shownSurface` falls back while it is not registered.
 */
export function panelSurfaceOf(stored: string | null): PanelSurface {
  if (stored?.startsWith("plugin:") === true) return stored as PluginSurfaceId;
  return SURFACES.find((surface) => surface.id === stored)?.id ?? "tasks";
}

/** The surface to show: Tasks while a plugin surface is not (or no longer) registered. */
export function shownSurface(surface: PanelSurface, panels: readonly PluginPanel[]): PanelSurface {
  return surface.startsWith("plugin:") && !panels.some((panel) => panel.surface === surface) ? "tasks" : surface;
}

const PLUGIN_ICON = <Puzzle className="size-4" aria-hidden="true" />;

function LiveDot() {
  return (
    <span
      aria-label="Live activity"
      className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-primary"
      role="img"
    />
  );
}

/**
 * The surface switch: one icon per surface. An icon opens its surface; the
 * shown surface's icon closes the panel. No fill marks the shown one (only
 * the Overview toggle has an on state): while the panel is open the other
 * icons dim instead. The Tasks icon carries the live-activity dot while
 * Tasks is out of sight. A phone header has room for one button, which opens
 * the last surface.
 */
export function SurfaceButtons({
  narrow,
  open,
  surface: selected,
  liveActivity,
  pluginPanels = [],
  onSelect,
}: {
  narrow: boolean;
  open: boolean;
  surface: PanelSurface;
  /** Foreground work Tasks would show is running. */
  liveActivity: boolean;
  /** Plugin surfaces, after the built-in ones; one shared icon, told apart by label. */
  pluginPanels?: readonly PluginPanel[];
  onSelect: (surface: PanelSurface) => void;
}) {
  const surface = shownSurface(selected, pluginPanels);
  if (narrow) {
    return (
      <span className="relative">
        <IconButton
          icon={<AnimatedSidebarRight className="size-4" />}
          label="Side panel"
          size="sm"
          tooltip="Show side panel"
          variant="ghost"
          onClick={() => onSelect(surface)}
        />
        {!open && liveActivity ? <LiveDot /> : null}
      </span>
    );
  }
  return (
    <>
      {[
        ...SURFACES,
        ...pluginPanels.map((panel) => ({ id: panel.surface, label: panel.label, icon: PLUGIN_ICON })),
      ].map((entry: { id: PanelSurface; label: string; icon: ReactNode }) => {
        const shown = open && surface === entry.id;
        return (
          <span key={entry.id} className="relative">
            <IconButton
              aria-pressed={shown}
              className={open && !shown ? "text-muted-foreground" : undefined}
              icon={entry.icon}
              label={entry.label}
              size="sm"
              tooltip={shown ? `Hide ${entry.label}` : `Show ${entry.label}`}
              variant="ghost"
              onClick={() => onSelect(entry.id)}
            />
            {entry.id === "tasks" && !shown && liveActivity ? <LiveDot /> : null}
          </span>
        );
      })}
    </>
  );
}

const STATUS_VARIANT = { "needs-answer": "warning", failed: "error", running: "success" } as const;
const STATUS_LABEL = { "needs-answer": "Waiting for your answer", failed: "Failed", running: "Running" } as const;

/** A conversation's own status dot — decorative inside its row/detail. */
function StatusGlyph({ status }: { status: ConversationSummary["status"] }) {
  if (status === undefined) return null;
  return (
    <span aria-hidden="true">
      <StatusDot variant={STATUS_VARIANT[status]} label={STATUS_LABEL[status]} pulsing={status !== "failed"} />
    </span>
  );
}

/**
 * The Tasks surface: the shown family's subagents, grouped by owner, or the
 * open subagent's transcript. The bar's `start` and `end` hold the phone
 * dialog's switch and close button.
 */
function TasksSurface({
  view,
  remote,
  shownId,
  barStart,
  barEnd,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The main column's conversation, loaded or not — while drafting, the family is empty. */
  shownId: ConversationId | undefined;
  barStart?: ReactNode;
  barEnd?: ReactNode;
  openInPanel: (id: ConversationId) => void;
  onOpenInMain: (id: ConversationId) => void;
}) {
  const now = useNow(60_000);
  // The family is whatever the main column shows — the panel is its sibling.
  const root = shownId === undefined ? undefined : rootOf(view.organized, shownId);
  const rootId = root?.summary.id;
  // Opening another family closes the side only once that family has loaded
  // (the close queues behind the switch); until then its detail is not ours.
  const side =
    view.side !== undefined && root !== undefined && rootOf(view.organized, view.side.id)?.summary.id === root.summary.id
      ? view.side
      : undefined;
  const sideSummary = side === undefined ? undefined : findConversation(view.organized, side.id)?.summary;
  // The list belongs to the family root, so a shown fork reads the root's copy.
  const processList = useProcessList(remote.processes, rootId);
  const processRows = processList?.processes ?? [];
  const [selectedProcess, setSelectedProcess] = useState<{ rootId: ConversationId; id: ProcessId }>();
  const sideId = side?.id;
  // Another family, or a subagent side opening over it, ends the process
  // detail. Closing a side from `openProcess` must not clear the new one.
  useEffect(() => setSelectedProcess(undefined), [rootId]);
  useEffect(() => {
    if (sideId !== undefined) setSelectedProcess(undefined);
  }, [sideId]);
  const groups = root === undefined ? [] : taskGroupsOf(root);
  const selected =
    selectedProcess !== undefined && selectedProcess.rootId === rootId
      ? processRows.find((process) => process.id === selectedProcess.id)
      : undefined;
  const closeSide = (): void => void remote.controller.showSide(undefined);
  const openProcess = (id: ProcessId): void => {
    if (rootId === undefined) return;
    // Selecting a process is a task navigation too: close any subagent detail.
    if (view.side !== undefined) void remote.controller.showSide(undefined);
    setSelectedProcess({ rootId, id });
  };
  if (side !== undefined && sideSummary?.kind === "subagent") {
    return (
      <div className="flex flex-col h-full min-h-0">
        <SurfaceBar start={barStart} end={barEnd}>
          <IconButton icon={<ArrowLeft className="size-4" aria-hidden="true" />} label="Back to tasks" size="sm" variant="ghost" onClick={closeSide} />
          <StatusGlyph status={sideSummary.status} />
          <span className="min-w-0 flex-1 truncate text-sm">{conversationName(sideSummary)}</span>
        </SurfaceBar>
        <TaskDetail
          view={view}
          side={side}
          onStop={
            canStopSubagent(sideSummary, view.host?.protocol.minor ?? 0) && view.connection === "connected"
              ? () => void remote.controller.abort(side.id)
              : undefined
          }
          openInPanel={openInPanel}
          onOpenInMain={onOpenInMain}
          onLoadEarlier={() => remote.controller.loadEarlier(side.id)}
        />
      </div>
    );
  }

  if (selected !== undefined && processList !== undefined && rootId !== undefined) {
    return (
      <ProcessDetail
        key={selected.id}
        process={selected}
        list={processList}
        remote={remote}
        conversationId={rootId}
        barStart={barStart}
        barEnd={barEnd}
        onBack={() => setSelectedProcess(undefined)}
      />
    );
  }

  const { active, done, failed } = taskTally(groups.flatMap((group) => group.tasks.map((node) => node.summary)));
  const runningProcesses = processRows.filter((process) => isProcessActive(process.state)).length;
  const tally = [
    active.length > 0 ? `${active.length} running` : undefined,
    done > 0 ? `${done} done` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    runningProcesses > 0
      ? `${runningProcesses} ${runningProcesses === 1 ? "process" : "processes"} running`
      : undefined,
  ].filter((part) => part !== undefined);
  return (
    <div className="flex flex-col h-full min-h-0">
      <SurfaceBar start={barStart} end={barEnd}>
        <span className="truncate text-sm text-muted-foreground">{tally.join(" · ")}</span>
      </SurfaceBar>
      <Scrollable>
          {groups.length === 0 && processRows.length === 0 ? (
            <span className="text-xs/5 text-muted-foreground p-3 text-muted-foreground">
              No tasks yet
            </span>
          ) : (
            <>
              {groups.map((group) => (
                <RowGroup key={group.owner.id} label={group.label}>
                  {orderedSubagents(group.tasks.map((node) => node.summary)).map((summary) => (
                    <SideRow key={summary.id} summary={summary} now={now} onOpen={() => openInPanel(summary.id)} />
                  ))}
                </RowGroup>
              ))}
              {processRows.length === 0 ? null : (
                <ProcessGroup processes={processRows} now={now} onOpen={openProcess} />
              )}
            </>
          )}
      </Scrollable>
    </div>
  );
}

/** A titled run of rows; the title names the list. */
function RowGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col">
      {/* Padded to sit on the rows' text edge. */}
      <div id={id} className="mb-2 px-3 pt-2">
        <span className="text-sm/5 font-semibold">{label}</span>
      </div>
      <ItemGroup aria-labelledby={id}>{children}</ItemGroup>
    </div>
  );
}

function Scrollable({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** The second line of a subagent row: its state in words, and what it is doing while it works. */
function subagentStateText(summary: ConversationSummary): string {
  switch (summary.status) {
    case "needs-answer":
      return "Waiting for an answer";
    case "failed":
      return "Failed";
    case "running": {
      const activity = summary.activity;
      if (activity === undefined) return "Running";
      const tool = toolDisplayName(activity.tool) ?? activity.tool;
      return `Running · ${tool}${activity.target === undefined ? "" : ` ${activity.target}`}`;
    }
    default:
      return "Done";
  }
}

/** A subagent row: its glyph, name, state in words, and when it last changed. */
function SideRow({
  summary,
  now,
  onOpen,
}: {
  summary: ConversationSummary;
  now: number;
  onOpen: () => void;
}) {
  return (
    <Item size="sm" render={<li />}>
      <ItemMedia>
        <TaskGlyph kind="subagent" tone={subagentTone(summary.status)} />
      </ItemMedia>
      <ItemContent render={<button type="button" onClick={onOpen} />}>
        <ItemTitle>{conversationName(summary)}</ItemTitle>
        <ItemDescription className={summary.status === "failed" ? "text-destructive" : undefined}>
          {subagentStateText(summary)}
        </ItemDescription>
      </ItemContent>
      {summary.updatedAt === undefined ? null : (
        <ItemActions>
          <span aria-hidden="true" className="text-xs text-muted-foreground tabular-nums">
            {agoText(relativeTime(summary.updatedAt, now))}
          </span>
        </ItemActions>
      )}
    </Item>
  );
}



const PROCESS_DOT = { running: "success", failed: "error", done: "neutral" } as const;

/** A process detail's status light, beside its name in the bar. */
function ProcessGlyph({ state }: { state: ProcessState }) {
  const tone = processTone(state);
  return (
    <span aria-hidden="true">
      <StatusDot variant={PROCESS_DOT[tone]} label={processShortText(state)} pulsing={tone === "running"} />
    </span>
  );
}

/** A process row: its glyph, name, state in words (and command when it differs), and when it last changed. */
function ProcessRow({ process, now, onOpen }: { process: ProcessInfo; now: number; onOpen: () => void }) {
  const tone = processTone(process.state);
  return (
    <Item size="sm" render={<li />}>
      <ItemMedia>
        <TaskGlyph kind="process" tone={tone} />
      </ItemMedia>
      <ItemContent render={<button type="button" onClick={onOpen} />}>
        <ItemTitle>{process.name}</ItemTitle>
        <ItemDescription>
          <span className={tone === "failed" ? "text-destructive" : undefined}>{processShortText(process.state)}</span>
          {process.name === process.command ? null : (
            <>
              {" · "}
              <span className="font-mono">{process.command}</span>
            </>
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span aria-hidden="true" className="text-xs text-muted-foreground tabular-nums">
          {agoText(relativeTime(process.endedAt ?? process.startedAt, now))}
        </span>
      </ItemActions>
    </Item>
  );
}

/** The family's processes beside its Foreground subagent groups. */
function ProcessGroup({ processes, now, onOpen }: { processes: readonly ProcessInfo[]; now: number; onOpen: (id: ProcessId) => void }) {
  return (
    <RowGroup label="Processes">
      {orderedProcesses(processes).map((process) => (
        <ProcessRow key={process.id} process={process} now={now} onOpen={() => onOpen(process.id)} />
      ))}
    </RowGroup>
  );
}

/** A process's read-only screen; no Stop once it ended or the host lost the pty. */
function ProcessDetail({
  process,
  list,
  remote,
  conversationId,
  barStart,
  barEnd,
  onBack,
}: {
  process: ProcessInfo;
  list: ProcessListState;
  remote: RemoteDurable;
  conversationId: ConversationId;
  barStart?: ReactNode;
  barEnd?: ReactNode;
  onBack: () => void;
}) {
  const [ended, setEnded] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const error = useErrorToast();
  const canStop = isProcessActive(process.state) && list.unavailable === undefined;
  const lost =
    process.state === "lost"
      ? "The host restarted, so this process's output is no longer available."
      : undefined;
  const unavailable = list.unavailable ?? lost ?? ended;
  const status =
    processStatusText(process.state)
    + (process.state === "lost" && process.pid !== undefined ? ` (pid ${process.pid})` : "");
  const stop = (): void => {
    setStopping(true);
    error.clear();
    remote.processes.stop(conversationId, process.id).then(
      () => setStopping(false),
      (reason: unknown) => {
        error.show(`Couldn't stop ${process.name}: ${reason instanceof Error ? reason.message : String(reason)}`);
        setStopping(false);
      },
    );
  };
  return (
    <div className="flex flex-col h-full min-h-0">
      <SurfaceBar
        start={barStart}
        end={
          <>
            {canStop ? <Button size="sm" variant="secondary" disabled={stopping} onClick={stop}>Stop</Button> : null}
            {barEnd}
          </>
        }
      >
        <IconButton
          icon={<ArrowLeft className="size-4" aria-hidden="true" />}
          label="Back to tasks"
          size="sm"
          variant="ghost"
          onClick={onBack}
        />
        <ProcessGlyph state={process.state} />
        <span className="min-w-0 flex-1 truncate text-sm">{process.name}</span>
      </SurfaceBar>
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="break-all font-mono text-xs">{process.command}</div>
        <div className="mt-1 text-xs text-muted-foreground">{status}</div>
      </div>
      <div className="min-h-0 flex-1">
        {unavailable === undefined ? (
          <Suspense fallback={null}>
            <LazyXtermView processes={remote.processes} processId={process.id} onEnded={setEnded} />
          </Suspense>
        ) : (
          <span className="text-xs/5 text-muted-foreground block p-3 text-muted-foreground">
            {unavailable}
          </span>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-2 text-center text-xs text-muted-foreground">
        Background processes stop when the host restarts.
      </div>
    </div>
  );
}

/**
 * A subagent in the panel: its transcript, read-only, with Stop while it is
 * at work (ADR-0047 §2). Main shows the same thing with more room.
 */
function TaskDetail({
  view,
  side,
  onStop,
  openInPanel,
  onOpenInMain,
  onLoadEarlier,
}: {
  view: DurableView;
  side: SideConversationView;
  /** Present while the subagent can be stopped. */
  onStop: (() => void) | undefined;
  openInPanel: (id: ConversationId) => void;
  onOpenInMain: (id: ConversationId) => void;
  onLoadEarlier: () => Promise<void>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {side.conversation === undefined ? (
          <ConversationSkeleton />
        ) : (
          <PluginScope conversationId={side.id} docs={side.docs}>
            <ConversationTranscript
              conversation={side.conversation}
              onLoadEarlier={onLoadEarlier}
              docs={side.docs}
              submissions={view.submissions}
              mergeQueuedSubmissions
              toolPresentations={view.toolPresentations}
              connected={view.connection === "connected"}
              canFork={false}
              openInPanel={openInPanel}
              onOpenFork={onOpenInMain}
              onFork={() => {}}
              summaryOf={(id) => findConversation(view.organized, id)?.summary}
              forksAt={(entryId) => forksAt(view.organized, side.id, entryId)}
            />
          </PluginScope>
        )}
      </div>
      <div className="flex justify-center gap-2 p-2 shrink-0 border-t border-border">
        {onStop === undefined ? null : <Button variant="secondary" size="sm" onClick={onStop}>Stop</Button>}
        <Button variant="ghost" size="sm" onClick={() => onOpenInMain(side.id)}>Open in main</Button>
      </div>
    </div>
  );
}

/** A plugin's panel: its label in the bar, its component below, isolated from the shell. */
function PluginSurface({ panel, barStart, barEnd }: { panel: PluginPanel; barStart?: ReactNode; barEnd?: ReactNode }) {
  const Panel = panel.component;
  return (
    <div className="flex flex-col h-full min-h-0">
      <SurfaceBar start={barStart} end={barEnd}>
        <span className="min-w-0 flex-1 truncate text-sm">{panel.label}</span>
      </SurfaceBar>
      <Scrollable>
        <PluginSlot key={panel.surface} plugin={panel.plugin}>
          <Panel />
        </PluginSlot>
      </Scrollable>
    </div>
  );
}

const PANEL_MIN_PX = 360;
const PANEL_MAX_PX = 1200;

/**
 * The width the row leaves the panel once the chat column, its previous
 * sibling, keeps its own minimum; tracked so the drag never runs past what the
 * window can show (the resize handle clamps a drag to its `max`, not the layout).
 */
function useRoomBeside(panel: HTMLElement | null): number | undefined {
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    const row = panel?.parentElement;
    const chat = panel?.previousElementSibling;
    if (row == null || !(chat instanceof HTMLElement)) return;
    const measure = () => setRoom(row.clientWidth - parseFloat(getComputedStyle(chat).minWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [panel]);
  return room;
}

/**
 * Desktop: a resizable, full-height panel docked right of the chat column; its
 * first row sits level with the chat header and ends in a close button.
 * Narrow: a fullscreen dialog whose first row also starts with the surface
 * switch.
 */
export function SidePanel({
  view,
  remote,
  shownId,
  narrow,
  open,
  surface: selected,
  pluginPanels = [],
  busy,
  liveActivity,
  onOpenChange,
  onSelectSurface,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The main column's conversation, loaded or not; the family comes from it, not view.conversation. */
  shownId: ConversationId | undefined;
  narrow: boolean;
  open: boolean;
  surface: PanelSurface;
  pluginPanels?: readonly PluginPanel[];
  /** The shown conversation is running; Changes refreshes once it settles. */
  busy: boolean;
  liveActivity: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSurface: (surface: PanelSurface) => void;
  openInPanel: (id: ConversationId) => void;
  onOpenInMain: (id: ConversationId) => void;
}) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const surface = shownSurface(selected, pluginPanels);
  const pluginPanel = pluginPanels.find((entry) => entry.surface === surface);
  const room = useRoomBeside(panel);
  const maxSizePx = Math.max(PANEL_MIN_PX, Math.min(PANEL_MAX_PX, room ?? PANEL_MAX_PX));
  const resizable = useResizableWidth({
    defaultSize: 440,
    min: PANEL_MIN_PX,
    max: maxSizePx,
    autoSaveId: "pinomad-side-panel",
  });
  // A width the window no longer has would make the first stretch of a drag
  // move nothing; settle on what fits instead.
  const { size, resize } = resizable;
  useEffect(() => {
    if (size > maxSizePx) resize(maxSizePx);
  }, [size, maxSizePx, resize]);
  const content = (barStart?: ReactNode, barEnd?: ReactNode) =>
    pluginPanel !== undefined ? (
      <PluginSurface panel={pluginPanel} barStart={barStart} barEnd={barEnd} />
    ) : surface === "changes" ? (
      <ChangesSurface view={view} remote={remote} shownId={shownId} busy={busy} barStart={barStart} barEnd={barEnd} />
    ) : surface === "terminal" ? (
      <TerminalSurface
        terminals={remote.terminals}
        // The host finds the owner from this id; the shown conversation's own
        // snapshot need not have landed.
        conversationId={shownId}
        connected={view.connection === "connected"}
        stacked={narrow}
        barStart={barStart}
        barEnd={barEnd}
      />
    ) : (
      <TasksSurface
        view={view}
        remote={remote}
        shownId={shownId}
        barStart={barStart}
        barEnd={barEnd}
        openInPanel={openInPanel}
        onOpenInMain={onOpenInMain}
      />
    );
  const close = (
    <IconButton
      icon={<Cancel className="size-4" aria-hidden="true" />}
      label="Close side panel"
      size="sm"
      variant="ghost"
      onClick={() => onOpenChange(false)}
    />
  );
  if (narrow) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent variant="fullscreen" aria-label="Side panel" showCloseButton={false}>
          {content(
            <SurfaceButtons
              narrow={false}
              open
              surface={surface}
              liveActivity={liveActivity}
              pluginPanels={pluginPanels}
              onSelect={onSelectSurface}
            />,
            close,
          )}
        </DialogContent>
      </Dialog>
    );
  }
  if (!open) return null;
  return (
    // The panel shrinks toward its minimum before the chat column gives up the
    // room its header needs.
    <div
      ref={setPanel}
      className="pigui-pane pigui-side-pane relative h-full min-w-[360px]"
      style={{ width: resizable.size }}
      aria-label="Side panel"
      role="complementary"
    >
      <div className="h-full min-h-0 overflow-hidden">
        {content(undefined, close)}
      </div>
      <ResizeHandle
        // The handle defaults to the end edge; reversed only changes drag direction.
        // Pulled back by half its width plus half the gap between the panes,
        // so the grip sits in the gap; the extra 1px is the pane's border,
        // since an absolute offset starts inside it.
        className="start-[calc(-0.5rem-var(--pigui-pane-gap)/2-1px)] end-auto"
        reversed
        label="Resize side panel"
        width={resizable}
      />
    </div>
  );
}
