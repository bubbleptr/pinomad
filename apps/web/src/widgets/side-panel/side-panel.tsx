// The right-side panel holds fixed surfaces (ADR-0040), switched from their
// icons at the right of the chat header. Each surface owns the panel's first
// row, level with that header, for its status and actions. Tasks is the
// family's Foreground subagents grouped by owner, opening read-only detail via
// `view.side`; Background subagents open in main and never repeat here.
// Changes is the shown conversation's checkout diff (changes-surface.tsx);
// Terminal is the terminals' owner's shells (terminal-surface.tsx).
import { Dialog } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableView, SideConversationView } from "@pinomad/protocol/view.ts";
import { displayName, forksAt, relativeTime, rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { useNow } from "../../shared/use-now.ts";
import { taskTally } from "../../entities/conversation/task-tally.ts";
import { AnimatedSidebarRight } from "../../shared/ui/animated-icons.tsx";
import { ArrowLeft, Bot, Cancel, CommandLine, FileDiff } from "../../shared/ui/icons.tsx";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";
import { ConversationTranscript } from "../chat/conversation-transcript.tsx";
import { ConversationSkeleton } from "../chat/conversation-skeleton.tsx";
import { ChangesSurface } from "./changes-surface.tsx";
import { SurfaceBar } from "./surface-bar.tsx";
import { TerminalSurface } from "./terminal-surface.tsx";

export type PanelSurface = "tasks" | "changes" | "terminal";

const SURFACES: readonly { readonly id: PanelSurface; readonly label: string; readonly icon: ReactNode }[] = [
  { id: "tasks", label: "Tasks", icon: <Bot className="size-4" aria-hidden="true" /> },
  { id: "changes", label: "Changes", icon: <FileDiff className="size-4" aria-hidden="true" /> },
  { id: "terminal", label: "Terminal", icon: <CommandLine className="size-4" aria-hidden="true" /> },
];

/** A stored surface id, or Tasks when it names none of today's surfaces. */
export function panelSurfaceOf(stored: string | null): PanelSurface {
  return SURFACES.find((surface) => surface.id === stored)?.id ?? "tasks";
}

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
 * shown surface's icon closes the panel. The Tasks icon carries the
 * live-activity dot while Tasks is out of sight. A phone header has room for
 * one button, which opens the last surface.
 */
export function SurfaceButtons({
  narrow,
  open,
  surface,
  liveActivity,
  onSelect,
}: {
  narrow: boolean;
  open: boolean;
  surface: PanelSurface;
  /** Foreground work Tasks would show is running. */
  liveActivity: boolean;
  onSelect: (surface: PanelSurface) => void;
}) {
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
      {SURFACES.map((entry) => {
        const shown = open && surface === entry.id;
        return (
          <span key={entry.id} className="relative">
            <IconButton
              aria-pressed={shown}
              // The shaded button says the surface is shown, beside aria-pressed.
              className={shown ? "bg-[var(--color-overlay-pressed)]" : undefined}
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
      <StatusDot variant={STATUS_VARIANT[status]} label={STATUS_LABEL[status]} isPulsing={status !== "failed"} />
    </span>
  );
}

/**
 * The Tasks surface: the shown family's Foreground Tasks, grouped by owner, or
 * the open subagent's read-only detail. Background subagents are promoted to
 * main rather than rendered as a second Tasks entry point. The bar's `start`
 * and `end` hold the phone dialog's switch and close button.
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
  // Opening another family closes the side only once that family has loaded
  // (the close queues behind the switch); until then its detail is not ours.
  const side =
    view.side !== undefined && root !== undefined && rootOf(view.organized, view.side.id)?.summary.id === root.summary.id
      ? view.side
      : undefined;
  const sideSummary = side === undefined ? undefined : findConversation(view.organized, side.id)?.summary;
  const groups = root === undefined ? [] : taskGroupsOf(root);
  const closeSide = (): void => void remote.controller.showSide(undefined);
  const backgroundSideId = sideSummary?.kind === "subagent" && sideSummary.lifecycle === "background" ? sideSummary.id : undefined;
  // Older links may still name a background detail explicitly. Promote rather
  // than rendering a second Tasks entry point for the same conversation.
  useEffect(() => {
    if (backgroundSideId !== undefined) onOpenInMain(backgroundSideId);
  }, [backgroundSideId, onOpenInMain]);

  if (side !== undefined && sideSummary?.kind === "subagent" && sideSummary.lifecycle !== "background") {
    return (
      <VStack className="h-full min-h-0" gap={0}>
        <SurfaceBar start={barStart} end={barEnd}>
          <IconButton icon={<ArrowLeft className="size-4" aria-hidden="true" />} label="Back to tasks" size="sm" variant="ghost" onClick={closeSide} />
          <StatusGlyph status={sideSummary.status} />
          <span className="min-w-0 flex-1 truncate text-sm">{displayName(sideSummary)}</span>
        </SurfaceBar>
        <TaskDetail
          view={view}
          side={side}
          openInPanel={openInPanel}
          onOpenInMain={onOpenInMain}
          onLoadEarlier={() => remote.controller.loadEarlier(side.id)}
        />
      </VStack>
    );
  }
  const { active, done, failed } = taskTally(groups.flatMap((group) => group.tasks.map((node) => node.summary)));
  const tally = [
    active.length > 0 ? `${active.length} running` : undefined,
    done > 0 ? `${done} done` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
  ].filter((part) => part !== undefined);
  return (
    <VStack className="h-full min-h-0" gap={0}>
      <SurfaceBar start={barStart} end={barEnd}>
        <span className="truncate text-sm text-muted">{tally.join(" · ")}</span>
      </SurfaceBar>
      <Scrollable>
          {groups.length === 0 ? (
            <Text type="supporting" className="p-3 text-muted">
              No tasks yet
            </Text>
          ) : (
            groups.map((group) => (
              <List
                key={group.owner.id}
                density="compact"
                header={
                  // List renders headers bare — pad to sit on the rows' text edge.
                  <div className="px-3 pt-2">
                    <Text type="label" weight="semibold">
                      {group.label}
                    </Text>
                  </div>
                }
              >
                {group.tasks.map((node) => (
                  <SideRow
                    key={node.summary.id}
                    summary={node.summary}
                    now={now}
                    onOpen={() => openInPanel(node.summary.id)}
                  />
                ))}
              </List>
            ))
          )}
      </Scrollable>
    </VStack>
  );
}

function Scrollable({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** A task row: status dot, display name, relative time. */
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
    <ListItem
      label={displayName(summary)}
      description={
        summary.status === "running" && summary.activity !== undefined
          ? `→ ${toolDisplayName(summary.activity.tool) ?? summary.activity.tool}${summary.activity.target === undefined ? "" : ` ${summary.activity.target}`}`
          : undefined
      }
      startContent={<StatusGlyph status={summary.status} />}
      endContent={
        summary.updatedAt === undefined ? undefined : (
          <span aria-hidden="true" className="text-xs text-muted">
            {relativeTime(summary.updatedAt, now)}
          </span>
        )
      }
      onClick={onOpen}
    />
  );
}

/** A subagent in the panel: transcript only, no way to talk to it. */
function TaskDetail({
  view,
  side,
  openInPanel,
  onOpenInMain,
  onLoadEarlier,
}: {
  view: DurableView;
  side: SideConversationView;
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
        )}
      </div>
      <div className="shrink-0 border-t border-border p-2 text-center text-xs text-muted">Read-only · subagent</div>
    </div>
  );
}

const PANEL_MIN_PX = 360;
const PANEL_MAX_PX = 1200;

/**
 * The width the row leaves the panel once the chat column, its previous
 * sibling, keeps its own minimum; tracked so the drag never runs past what the
 * window can show (Astryx clamps a drag to `maxSizePx`, not the layout).
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
 * first row sits level with the chat header. Narrow: a fullscreen dialog whose
 * first row adds the surface switch and a close button.
 */
export function SidePanel({
  view,
  remote,
  shownId,
  narrow,
  open,
  surface,
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
  /** The shown conversation is running; Changes refreshes once it settles. */
  busy: boolean;
  liveActivity: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSurface: (surface: PanelSurface) => void;
  openInPanel: (id: ConversationId) => void;
  onOpenInMain: (id: ConversationId) => void;
}) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const room = useRoomBeside(panel);
  const maxSizePx = Math.max(PANEL_MIN_PX, Math.min(PANEL_MAX_PX, room ?? PANEL_MAX_PX));
  const resizable = useResizable({
    defaultSize: 440,
    minSizePx: PANEL_MIN_PX,
    maxSizePx,
    autoSaveId: "pinomad-side-panel",
  });
  // A width the window no longer has would make the first stretch of a drag
  // move nothing; settle on what fits instead.
  const { size, resize } = resizable;
  useEffect(() => {
    if (size > maxSizePx) resize(maxSizePx);
  }, [size, maxSizePx, resize]);
  const content = (barStart?: ReactNode, barEnd?: ReactNode) =>
    surface === "changes" ? (
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
  if (narrow) {
    return (
      <Dialog isOpen={open} onOpenChange={onOpenChange} variant="fullscreen" aria-label="Side panel">
        <Layout
          content={
            <LayoutContent padding={0}>
              {content(
                <SurfaceButtons narrow={false} open surface={surface} liveActivity={liveActivity} onSelect={onSelectSurface} />,
                <IconButton
                  icon={<Cancel className="size-4" aria-hidden="true" />}
                  label="Close side panel"
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                />,
              )}
            </LayoutContent>
          }
        />
      </Dialog>
    );
  }
  if (!open) return null;
  return (
    // The panel shrinks toward its minimum before the chat column gives up the
    // room its header needs.
    <div
      ref={setPanel}
      className="relative h-full min-w-[360px] border-l border-border"
      style={{ width: resizable.size }}
      aria-label="Side panel"
      role="complementary"
    >
      <div className="h-full min-h-0 overflow-hidden">
        {content()}
      </div>
      <ResizeHandle
        direction="horizontal"
        position="overlay"
        // Overlay defaults to the end edge; isReversed only changes drag direction.
        // Pulled back by half its width (and half the 1px border) so the grip
        // sits on the divider, half over the chat column.
        className="start-[calc(-0.5rem-0.5px)]! end-auto!"
        // Centering keeps Astryx's grab zone full-height instead of shifted up by 50%.
        pillPlacement="center"
        isReversed
        label="Resize side panel"
        resizable={resizable.props}
      />
    </div>
  );
}
