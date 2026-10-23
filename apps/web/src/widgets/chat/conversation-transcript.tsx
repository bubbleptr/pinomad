// The rendered transcript of a ConversationView — shared by the main column
// and the side panel's detail views. Items come from deriveChat; each run
// entry delegates to ChatEntryView.
import { ChatMessageList, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { useMemo } from "react";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { classify, type PresentationType, type TodoState } from "@pinomad/protocol/presentation.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { deriveChat, retryOf } from "@pinomad/client/cot-view.ts";
import type { ViewImage } from "@pinomad/protocol/images.ts";
import type { ConversationSummary, ExtensionDocView } from "@pinomad/protocol/view.ts";
import { lastTodoWriteMs } from "@/entities/todo/todo-card";
import { ChatEntryView } from "./chat-entries.tsx";

export function ConversationTranscript({
  conversation,
  toolPresentations,
  connected,
  canFork,
  openInPanel,
  onFork,
  forksAt,
  summaryOf,
  ownOnly,
  forkSource,
  onRetry,
  docs,
}: {
  conversation: ConversationView;
  toolPresentations: Record<string, PresentationType>;
  connected: boolean;
  canFork: boolean;
  /** Threads/tasks inside a transcript open beside the main area, not in it. */
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onFork: (entryId: string) => void;
  forksAt?: (entryId: string) => ConversationId[];
  /** Live summaries for subagent cards inside the transcript. */
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  /**
   * A fork beside its parent: render only the fork's own entries — the
   * inherited prefix already fills the main column — opened by a
   * "Forked from …" divider naming `forkSource`.
   */
  ownOnly?: boolean;
  /** The parent conversation's display name, for the "Forked from" divider. */
  forkSource?: string;
  /**
   * Resubmits the user message the newest run answered, when that run failed —
   * its images go back too. The retry carries a requestId derived from the
   * failed run, so a second click or another client's retry admits once on
   * the host. Absent on read-only transcripts (subagent conversations).
   */
  onRetry?: (retry: { text: string; images: readonly ViewImage[]; requestId: string }) => Promise<void>;
  /** The conversation's extension documents; its todo list rides under the newest run. */
  docs?: readonly ExtensionDocView[];
}) {
  const busy = isBusy(conversation);
  const view = useMemo(
    () =>
      ownOnly
        ? { ...conversation, entries: conversation.entries.filter((entry) => entry.conversationId === conversation.conversation.id) }
        : conversation,
    [conversation, ownOnly],
  );
  const items = useMemo(() => deriveChat(view, toolPresentations, busy), [view, toolPresentations, busy]);
  const retry = useMemo(() => retryOf(items), [items]);
  const todoState = useMemo(() => todoOf(docs), [docs]);
  const todoUpdatedAtMs = useMemo(() => lastTodoWriteMs(items), [items]);
  const todo = useMemo(
    () =>
      todoState === undefined
        ? undefined
        : { state: todoState, ...(todoUpdatedAtMs === undefined ? {} : { updatedAtMs: todoUpdatedAtMs }) },
    [todoState, todoUpdatedAtMs],
  );
  // One card at a time: only the newest run gets the list (ADR-0026 §4).
  const latestRun = items.findLastIndex((item) => item.kind === "run");
  if (items.length === 0 && !ownOnly) return null;
  return (
    <ChatMessageList isStreaming={busy} gap={0}>
      {/* Pace's live-session-column gutter: centered column with horizontal
          padding; chat.css's CoT rail expects that breathing room. */}
      <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
        {ownOnly ? <ChatSystemMessage variant="divider">Forked from {forkSource}</ChatSystemMessage> : null}
        {items.map((item, index) => (
          <ChatEntryView
            key={item.id}
            entry={item}
            connected={connected}
            openInPanel={openInPanel}
            onFork={onFork}
            canFork={canFork}
            forksAt={forksAt}
            summaryOf={summaryOf}
            {...(index === latestRun && todo !== undefined ? { todo } : {})}
            onRetry={
              onRetry !== undefined && connected && retry !== undefined && index === items.length - 1
                ? () => onRetry(retry)
                : undefined
            }
          />
        ))}
      </div>
    </ChatMessageList>
  );
}

function todoOf(docs: readonly ExtensionDocView[] | undefined): TodoState | undefined {
  for (const doc of docs ?? []) {
    if (doc.value === null) continue;
    const classified = classify(doc.presentation, doc.value);
    if (classified.type === "pinomad.todo") return classified.value;
  }
  return undefined;
}
