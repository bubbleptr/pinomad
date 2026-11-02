// The right-side panel is the family's Foreground Tasks: its subagents grouped
// by owner, opening read-only detail via `view.side`. Forks are independent
// conversations in the sidebar now, not a panel tab (ADR-0039). Background
// subagents open in main and never repeat here.
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableView, SideConversationView } from "@pinomad/protocol/view.ts";
import { displayName, forksAt, relativeTime, rootOf, taskGroupsOf } from "@pinomad/client/family.ts";
import { useNow } from "../../shared/use-now.ts";
import { ArrowLeft } from "../../shared/ui/icons.tsx";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";
import { ConversationTranscript } from "../chat/conversation-transcript.tsx";

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
 * The panel's body: the shown family's Foreground Tasks, grouped by owner, or
 * the open subagent's read-only detail. Background subagents are promoted to
 * main rather than rendered as a second Tasks entry point.
 */
function PanelContent({
  view,
  remote,
  shownId,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The main column's conversation, loaded or not — while drafting, the family is empty. */
  shownId: ConversationId | undefined;
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

  return (
    <VStack className="h-full min-h-0" gap={0}>
      {side !== undefined && sideSummary?.kind === "subagent" && sideSummary.lifecycle !== "background" ? (
        <TaskDetail
          view={view}
          remote={remote}
          side={side}
          summary={sideSummary}
          onBack={closeSide}
          openInPanel={openInPanel}
          onOpenInMain={onOpenInMain}
        />
      ) : (
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
      )}
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

/** The detail's top bar: back to the list, status dot, display name. */
function DetailHeader({
  back,
  title,
  status,
  onBack,
}: {
  back: string;
  title: string;
  status: ConversationSummary["status"];
  onBack: () => void;
}) {
  return (
    <HStack className="shrink-0 gap-1 border-b border-border px-2 py-1" vAlign="center">
      <IconButton icon={<ArrowLeft className="size-4" aria-hidden="true" />} label={back} size="sm" variant="ghost" onClick={onBack} />
      <StatusGlyph status={status} />
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
    </HStack>
  );
}

/** A subagent in the panel: transcript only, no way to talk to it. */
function TaskDetail({
  view,
  remote,
  side,
  summary,
  onBack,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  side: SideConversationView;
  summary: ConversationSummary;
  onBack: () => void;
  openInPanel: (id: ConversationId) => void;
  onOpenInMain: (id: ConversationId) => void;
}) {
  if (side.conversation === undefined) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader back="Back to tasks" title={displayName(summary)} status={summary.status} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ConversationTranscript
          conversation={side.conversation}
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
      </div>
      <div className="shrink-0 border-t border-border p-2 text-center text-xs text-muted">Read-only · subagent</div>
    </div>
  );
}

/**
 * Desktop: a resizable panel docked right of the main column. Narrow: a
 * fullscreen dialog — the same Tasks list and read-only detail.
 */
export function SidePanel({
  view,
  remote,
  shownId,
  narrow,
  open,
  onOpenChange,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The main column's conversation, loaded or not; the family comes from it, not view.conversation. */
  shownId: ConversationId | undefined;
  narrow: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openInPanel: (id: ConversationId) => void;
  onOpenInMain: (id: ConversationId) => void;
}) {
  const resizable = useResizable({
    defaultSize: 440,
    minSizePx: 360,
    maxSizePx: 720,
    autoSaveId: "pinomad-side-panel",
  });
  if (narrow) {
    return (
      <Dialog isOpen={open} onOpenChange={onOpenChange} variant="fullscreen">
        <Layout
          header={<DialogHeader title="Side panel" onOpenChange={onOpenChange} />}
          content={
            <LayoutContent padding={0}>
              <PanelContent
                view={view}
                remote={remote}
                shownId={shownId}
                openInPanel={openInPanel}
                onOpenInMain={onOpenInMain}
              />
            </LayoutContent>
          }
        />
      </Dialog>
    );
  }
  if (!open) return null;
  return (
    // Relative + overflow clip so the overlay resize handle sits on the left edge.
    <div className="relative h-full shrink-0 border-l border-border" style={{ width: resizable.size }} aria-label="Side panel" role="complementary">
      <div className="h-full min-h-0 overflow-hidden">
        <PanelContent
          view={view}
          remote={remote}
          shownId={shownId}
          openInPanel={openInPanel}
          onOpenInMain={onOpenInMain}
        />
      </div>
      <ResizeHandle
        direction="horizontal"
        position="overlay"
        isReversed
        label="Resize side panel"
        resizable={resizable.props}
      />
    </div>
  );
}
