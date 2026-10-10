// The right-side panel (ADR-0019's thread/task model): Threads lists the
// shown conversation's family forks and Tasks its subagents — both open
// inside the panel via `view.side` instead of replacing the main column.
// Live is what the Dock held. Forks are talkable (composer, targeted
// submit/abort/answer); subagents are read-only.
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { useState, type ReactNode } from "react";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { ConversationSummary, DurableView, SideConversationView } from "@pinomad/protocol/view.ts";
import { displayName, forksAt, relativeTime, rootOf, taskGroupsOf, threadsOf } from "../../entities/conversation/family.ts";
import { PendingQuestions } from "../../presentation/question.tsx";
import { useNow } from "../../shared/use-now.ts";
import { ArrowLeft } from "../../shared/ui/icons.tsx";
import { ChatPromptInput } from "../../shared/ui/chat/chat-prompt-input.tsx";
import { toolDisplayName } from "../../shared/ui/chat/chat-tool.tsx";
import { ConversationTranscript } from "../chat/conversation-transcript.tsx";
import { LiveState } from "./live-state.tsx";

export type PanelTab = "threads" | "tasks" | "live";

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
 * The panel's body: tabs, then a list or the open conversation's detail. The
 * detail lives inside the tab it belongs to (a fork under Threads, a subagent
 * under Tasks); the other tabs keep showing their lists.
 */
function PanelContent({
  view,
  remote,
  conversation,
  tab,
  onTabChange,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The draft-gated conversation — while drafting, the family is empty. */
  conversation: DurableView["conversation"];
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onOpenInMain: (id: ConversationId) => void;
}) {
  const now = useNow(60_000);
  const side = view.side;
  const sideSummary = side === undefined ? undefined : findConversation(view.organized, side.id)?.summary;
  // The family is whatever the main column shows — the panel is its sibling.
  const root = conversation === undefined ? undefined : rootOf(view.organized, conversation.conversation.id);
  const threads = root === undefined ? [] : threadsOf(root);
  const groups = root === undefined ? [] : taskGroupsOf(root);
  const taskCount = groups.reduce((total, group) => total + group.tasks.length, 0);
  const closeSide = (): void => void remote.controller.showSide(undefined);

  return (
    <VStack className="h-full min-h-0" gap={0}>
      <TabList value={tab} onChange={(value) => onTabChange(value as PanelTab)} layout="fill" hasDivider>
        <Tab
          value="threads"
          label="Threads"
          endContent={
            threads.length === 0 ? undefined : (
              <span aria-hidden="true" className="text-xs text-muted">
                {threads.length}
              </span>
            )
          }
        />
        <Tab
          value="tasks"
          label="Tasks"
          endContent={
            taskCount === 0 ? undefined : (
              <span aria-hidden="true" className="text-xs text-muted">
                {taskCount}
              </span>
            )
          }
        />
        <Tab value="live" label="Live" />
      </TabList>
      {tab === "threads" ? (
        side !== undefined && sideSummary?.kind === "fork" ? (
          <ThreadDetail
            // The draft lives inside the detail; a different fork means a
            // different draft — remounting keeps a stale one from being sent.
            key={side.id}
            view={view}
            remote={remote}
            side={side}
            summary={sideSummary}
            onBack={closeSide}
            onOpenInMain={onOpenInMain}
            openInPanel={openInPanel}
          />
        ) : (
          <Scrollable>
            {threads.length === 0 ? (
              <Text type="supporting" className="p-3 text-muted">
                No threads yet
              </Text>
            ) : (
              <List density="compact">
                {threads.map((node) => (
                  <SideRow
                    key={node.summary.id}
                    summary={node.summary}
                    now={now}
                    onOpen={() => openInPanel(node.summary.id, "threads")}
                  />
                ))}
              </List>
            )}
          </Scrollable>
        )
      ) : tab === "tasks" ? (
        side !== undefined && sideSummary?.kind === "subagent" ? (
          <TaskDetail
            view={view}
            remote={remote}
            side={side}
            summary={sideSummary}
            onBack={closeSide}
            openInPanel={openInPanel}
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
                      onOpen={() => openInPanel(node.summary.id, "tasks")}
                    />
                  ))}
                </List>
              ))
            )}
          </Scrollable>
        )
      ) : (
        <Scrollable label="Live state">
          <div className="p-3">
            <LiveState view={view} remote={remote} conversation={conversation} />
          </div>
        </Scrollable>
      )}
    </VStack>
  );
}

function Scrollable({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" {...(label === undefined ? {} : { "aria-label": label })}>
      {children}
    </div>
  );
}

/** A thread/task row: status dot, display name, relative time. */
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

/** The detail's top bar: back to the list, status dot, display name, extra action. */
function DetailHeader({
  back,
  title,
  status,
  onBack,
  extra,
}: {
  back: string;
  title: string;
  status: ConversationSummary["status"];
  onBack: () => void;
  extra?: ReactNode;
}) {
  return (
    <HStack className="shrink-0 gap-1 border-b border-border px-2 py-1" vAlign="center">
      <IconButton icon={<ArrowLeft className="size-4" aria-hidden="true" />} label={back} size="sm" variant="ghost" onClick={onBack} />
      <StatusGlyph status={status} />
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      {extra}
    </HStack>
  );
}

function SideTranscript({
  view,
  remote,
  side,
  openInPanel,
  ownOnly,
  forkSource,
}: {
  view: DurableView;
  remote: RemoteDurable;
  side: SideConversationView;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  /** Forks show only their own entries; the parent's prefix is in the main column. */
  ownOnly?: boolean;
  forkSource?: string;
}) {
  if (side.conversation === undefined) return null;
  return (
    <ConversationTranscript
      conversation={side.conversation}
      toolPresentations={view.toolPresentations}
      connected={view.connection === "connected"}
      // Fork depth is one: a fork's transcript never offers Fork.
      canFork={false}
      openInPanel={openInPanel}
      onFork={() => {}}
      ownOnly={ownOnly}
      forkSource={forkSource}
      summaryOf={(id) => findConversation(view.organized, id)?.summary}
      // Legacy trees nest forks inside forks: the side's own children may
      // still anchor a chip back to another thread.
      forksAt={(entryId) => forksAt(view.organized, side.id, entryId)}
    />
  );
}

/** A fork in the panel: transcript, its pending questions, and a composer. */
function ThreadDetail({
  view,
  remote,
  side,
  summary,
  onBack,
  onOpenInMain,
  openInPanel,
}: {
  view: DurableView;
  remote: RemoteDurable;
  side: SideConversationView;
  summary: ConversationSummary;
  onBack: () => void;
  onOpenInMain: (id: ConversationId) => void;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
}) {
  const conversation: ConversationView | undefined = side.conversation;
  const busy = conversation !== undefined && isBusy(conversation);
  const [draft, setDraft] = useState("");
  const submit = (): void => {
    const text = draft.trim();
    if (text === "") return;
    void remote.controller.submit(text, "followUp", side.id);
    setDraft("");
  };
  const parentSummary =
    summary.parent === undefined ? undefined : findConversation(view.organized, summary.parent)?.summary;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        back="Back to threads"
        title={displayName(summary)}
        status={summary.status}
        onBack={onBack}
        extra={<Button label="Open in main" variant="secondary" size="sm" onClick={() => onOpenInMain(side.id)} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SideTranscript
          view={view}
          remote={remote}
          side={side}
          openInPanel={openInPanel}
          ownOnly
          forkSource={displayName(parentSummary)}
        />
        <PendingQuestions
          docs={side.docs}
          remote={remote}
          connected={view.connection === "connected"}
          target={side.id}
        />
      </div>
      <div className="shrink-0 border-t border-border p-2">
        <ChatPromptInput
          value={draft}
          placeholder="Reply in this thread…"
          status={busy ? "streaming" : "ready"}
          isDisabled={view.connection !== "connected"}
          onSubmit={submit}
          onStop={() => void remote.controller.abort(side.id)}
          onValueChange={setDraft}
        />
      </div>
    </div>
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
}: {
  view: DurableView;
  remote: RemoteDurable;
  side: SideConversationView;
  summary: ConversationSummary;
  onBack: () => void;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader back="Back to tasks" title={displayName(summary)} status={summary.status} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SideTranscript view={view} remote={remote} side={side} openInPanel={openInPanel} />
      </div>
      <div className="shrink-0 border-t border-border p-2 text-center text-xs text-muted">Read-only · subagent</div>
    </div>
  );
}

/**
 * Desktop: a resizable panel docked right of the main column. Narrow: a
 * fullscreen dialog — the same tabs and details.
 */
export function SidePanel({
  view,
  remote,
  conversation,
  narrow,
  open,
  onOpenChange,
  tab,
  onTabChange,
  openInPanel,
  onOpenInMain,
}: {
  view: DurableView;
  remote: RemoteDurable;
  /** The draft-gated main conversation; the family comes from it, not view.conversation. */
  conversation: DurableView["conversation"];
  narrow: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
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
                conversation={conversation}
                tab={tab}
                onTabChange={onTabChange}
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
          conversation={conversation}
          tab={tab}
          onTabChange={onTabChange}
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
