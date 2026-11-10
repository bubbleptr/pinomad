// The rendered transcript of a ConversationView — shared by the main column
// and the side panel's detail views. Items come from deriveChat; each run
// entry delegates to ChatEntryView.
import { ChatMessageList } from "@astryxdesign/core/Chat";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { classify, type PresentationType, type TodoState } from "@pinomad/protocol/presentation.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { deriveChat, retryOf } from "@pinomad/client/cot-view.ts";
import type { UserAttachment } from "@pinomad/protocol/attachments.ts";
import type { ViewImage } from "@pinomad/protocol/images.ts";
import type { ConversationSummary, ExtensionDocView, LogicalSubmission } from "@pinomad/protocol/view.ts";
import { lastTodoWriteMs } from "@/entities/todo/todo-card";
import { ChatEntryView } from "./chat-entries.tsx";
import { useToday } from "./use-today.ts";

export function ConversationTranscript({
  conversation,
  toolPresentations,
  connected,
  canFork,
  openInPanel,
  onOpenFork,
  onFork,
  forkDisabled,
  forksAt,
  summaryOf,
  onRetry,
  onRetrySubmission,
  onEditSubmission,
  submissionEditDisabled,
  submissionEditTooltip,
  docs,
  submissions,
  mergeQueuedSubmissions,
  onLoadEarlier,
}: {
  conversation: ConversationView;
  toolPresentations: Record<string, PresentationType>;
  connected: boolean;
  canFork: boolean;
  /** Foreground tasks inside a transcript open beside the main area, not in it. */
  openInPanel: (id: ConversationId) => void;
  /** A forked message's chip opens that fork in the main area. */
  onOpenFork: (id: ConversationId) => void;
  onFork: (entryId: string) => void;
  /** Another fork create is already pending on this workbench. */
  forkDisabled?: boolean;
  forksAt?: (entryId: string) => ConversationId[];
  /** Live summaries for subagent cards inside the transcript. */
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  /**
   * Resubmits the user message the newest run answered, when that run failed —
   * its images and picked skills go back too. The retry carries a requestId derived from the
   * failed run, so a second click or another client's retry admits once on
   * the host. Absent on subagent transcripts: their runs belong to whoever sent each message.
   */
  onRetry?: (retry: {
    text: string;
    images: readonly ViewImage[];
    skills: readonly string[];
    attachments: readonly UserAttachment[];
    requestId: string;
  }) => Promise<void>;
  /** Resend a local send with its original requestId. */
  onRetrySubmission?: (requestId: string) => void;
  /** Take a failed or unconfirmed local send back for editing. */
  onEditSubmission?: (requestId: string) => void;
  /** The composer holds a draft or another take-back. */
  submissionEditDisabled?: boolean;
  /** Why the local Edit is disabled. */
  submissionEditTooltip?: string;
  /** The conversation's extension documents; its todo list rides under the newest run. */
  docs?: readonly ExtensionDocView[];
  /** Client-side sends that have not been replaced by the host's fact yet. */
  submissions?: readonly LogicalSubmission[];
  /** No queue list in this transcript; queue-placed local sends render as bubbles. */
  mergeQueuedSubmissions?: boolean;
  /** Loads the turns before the view; offered on scrolling to the top while the view has a `before`. */
  onLoadEarlier?: () => Promise<void>;
}) {
  const busy = isBusy(conversation);
  const today = useToday();
  const items = useMemo(
    () => deriveChat(conversation, toolPresentations, busy, submissions ?? [], { mergeQueuedSubmissions }),
    [conversation, toolPresentations, busy, submissions, mergeQueuedSubmissions],
  );
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

  const column = useRef<HTMLDivElement>(null);
  // The oldest shown row and its offset in the scroller before a load, so
  // the turns it adds land above what the reader was looking at, however
  // much a streaming answer grows below meanwhile (Safari has no
  // overflow-anchor, and Chromium's does nothing at scrollTop 0).
  const anchor = useRef<{ scroller: HTMLElement; row: Element; top: number } | undefined>(undefined);
  const before = conversation.before;
  // Callers pass a fresh arrow each render; reading it through a ref keeps
  // the list's IntersectionObserver from being rebuilt on every stream tick.
  const loadEarlierLatest = useRef(onLoadEarlier);
  loadEarlierLatest.current = onLoadEarlier;
  // A new identity per `before` and per reconnect re-arms the list's top
  // sentinel, so a page too short to scroll still loads the next one.
  const loadEarlier = useCallback(async () => {
    const load = loadEarlierLatest.current;
    if (load === undefined) return;
    const scroller = scrollerOf(column.current);
    const row = column.current?.firstElementChild;
    if (scroller !== undefined && row != null) anchor.current = { scroller, row, top: offsetIn(scroller, row) };
    try {
      await load();
    } catch {
      // Offline or the host refused: the sentinel stays, and the next
      // reconnect re-arms it.
      anchor.current = undefined;
    }
    // `before` and `connected` are deps only to re-arm the sentinel.
  }, [before, connected]);
  const oldest = items[0]?.id;
  useLayoutEffect(() => {
    const pending = anchor.current;
    if (pending === undefined) return;
    anchor.current = undefined;
    if (pending.row.isConnected) pending.scroller.scrollTop += offsetIn(pending.scroller, pending.row) - pending.top;
  }, [oldest]);

  if (items.length === 0) return null;
  return (
    <ChatMessageList
      isStreaming={busy}
      gap={0}
      scrollToTopAction={onLoadEarlier !== undefined && connected && before !== undefined ? loadEarlier : undefined}
    >
      {/* Pace's live-session-column gutter: centered column with horizontal
          padding; chat.css's CoT rail expects that breathing room. */}
      <div ref={column} className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
        {items.map((item, index) => (
          <ChatEntryView
            key={item.id}
            entry={item}
            connected={connected}
            openInPanel={openInPanel}
            onOpenFork={onOpenFork}
            onFork={onFork}
            canFork={canFork}
            forkDisabled={forkDisabled}
            forksAt={forksAt}
            summaryOf={summaryOf}
            onRetrySubmission={onRetrySubmission}
            onEditSubmission={onEditSubmission}
            submissionEditDisabled={submissionEditDisabled}
            submissionEditTooltip={submissionEditTooltip}
            today={today}
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

/** The nearest ancestor that scrolls vertically: the chat layout's area, or the side panel's. */
function scrollerOf(element: HTMLElement | null): HTMLElement | undefined {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return undefined;
}

/** Where `row` sits inside the scroller's viewport. */
function offsetIn(scroller: HTMLElement, row: Element): number {
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

function todoOf(docs: readonly ExtensionDocView[] | undefined): TodoState | undefined {
  for (const doc of docs ?? []) {
    if (doc.value === null) continue;
    const classified = classify(doc.presentation, doc.value);
    if (classified.type === "pinomad.todo") return classified.value;
  }
  return undefined;
}
