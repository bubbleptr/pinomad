// The rendered transcript of a ConversationView — shared by the main column
// and the side panel's detail views. Items come from deriveChat; each run
// entry delegates to ChatEntryView.
import { ChatMessageList, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { useMemo } from "react";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import type { PresentationType } from "@pinomad/protocol/presentation.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { deriveChat, retryPromptOf } from "@pinomad/client/cot-view.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
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
   * Resubmits the user message the newest run answered, when that run failed.
   * Absent on read-only transcripts (subagent conversations).
   */
  onRetry?: (text: string) => Promise<void>;
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
  const retry = useMemo(() => retryPromptOf(items), [items]);
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
