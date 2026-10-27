// ChatEntry rendering, after Pace's widgets/live-chat/live-chat-message.tsx:
// a user bubble, then one Assistant message per run — its folded process and
// Interim Output, the answer, the settled actions row (time, Copy + Fork, no
// thumbs), and on the newest run the todo card (ADR-0026).
import { ChatMessageMetadata, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { Token } from "@astryxdesign/core/Token";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { TodoState } from "@pinomad/protocol/presentation.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { splitSubagentCalls, type ChatEntry, type CotView } from "@pinomad/client/cot-view.ts";
import { useMemo, useState } from "react";
import { segmentRun } from "@/entities/run-trace/segment-run";
import { TodoCard } from "@/entities/todo/todo-card";
import {
  ChatChainOfThought as ChainOfThought,
  ChatTraceRow,
  formatElapsed,
} from "@/shared/ui/chat/chat-chain-of-thought";
import { ChatMarkdown, ChatStreamMarkdown } from "@/shared/ui/chat/chat-markdown";
import { ChatMessage, ChatMessageActions } from "@/shared/ui/chat/chat-message";
import { ChatRunFailure } from "@/shared/ui/chat/chat-run-failure";
import { MessageAttachments } from "../../entities/attachment/file-attachments.tsx";
import { MessageImages } from "../../entities/image/message-images.tsx";
import { GitFork } from "@/shared/ui/icons";
import { SkillMentionText } from "../../entities/agent/skill-mentions.tsx";
import { messageTime } from "./chat-time.ts";
import { SubagentCards } from "./subagent-card.tsx";
import { fillToolDetails } from "./tool-detail.tsx";

/** The conversation's todo list and when any run last wrote it (`lastTodoWriteMs`). */
type RunTodo = { state: TodoState; updatedAtMs?: number };

export function ChatEntryView({
  entry,
  connected,
  openInPanel,
  onFork,
  canFork = true,
  forksAt,
  summaryOf,
  onRetry,
  onRetrySubmission,
  onEditSubmission,
  todo,
  today,
}: {
  entry: ChatEntry;
  connected: boolean;
  /** Threads and tasks reached from a transcript open in the side panel. */
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onFork: (entryId: string) => void;
  /** False inside a fork or subagent conversation: depth is one (ADR-0019 §2). */
  canFork?: boolean;
  /** Forks anchored at an entry — legacy data can hold more than one (ADR-0019 §3). */
  forksAt?: (entryId: string) => ConversationId[];
  /** Resolves a conversation's summary — powers the subagent cards' live status. */
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  /** Only set on the newest entry when it is a failed run. */
  onRetry?: () => Promise<void>;
  /** Resend an unknown or failed logical submission with its original key. */
  onRetrySubmission?: (requestId: string) => void;
  /** Query/take back a failed or unconfirmed local send for editing. */
  onEditSubmission?: (requestId: string) => void;
  /** The conversation's todo list — handed to the newest run only, so one card shows. */
  todo?: RunTodo;
  /** Local start of today, shared by the transcript's midnight clock. */
  today?: number;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <UserEntry
          entry={entry}
          onRetrySubmission={onRetrySubmission}
          onEditSubmission={onEditSubmission}
          today={today}
        />
      );
    case "run":
      return (
        <RunEntry
          entry={entry}
          connected={connected}
          openInPanel={openInPanel}
          onFork={onFork}
          canFork={canFork}
          forksAt={forksAt}
          summaryOf={summaryOf}
          onRetry={onRetry}
          todo={todo}
          today={today}
        />
      );
    case "compaction":
      return <ChatSystemMessage variant="divider">Earlier context summarized</ChatSystemMessage>;
    case "reset":
      return <ChatSystemMessage variant="divider">New context</ChatSystemMessage>;
  }
}


function UserEntry({
  entry,
  onRetrySubmission,
  onEditSubmission,
  today,
}: {
  entry: Extract<ChatEntry, { kind: "user" }>;
  onRetrySubmission?: (requestId: string) => void;
  onEditSubmission?: (requestId: string) => void;
  today?: number;
}) {
  const local = entry.local;
  const [hovered, setHovered] = useState(false);
  const canAct = local !== undefined && (entry.status === "unknown" || entry.status === "failed");
  const canEdit = local !== undefined && entry.status === "failed";
  const status =
    entry.status === "failed"
      ? ("error" as const)
      : entry.status === "unknown"
        ? ("sending" as const)
        : entry.status;
  const footer =
    entry.text !== "" || canAct || local?.error !== undefined ? (
      <div className="chat-message__metadata-footer">
        {local?.error === undefined ? null : (
          <span className="chat-message__local-error" title={local.error}>
            {local.error}
          </span>
        )}
        {entry.text === "" ? null : (
          <ChatMessageActions className="chat-message__actions--inline">
            <ChatMessageActions.Copy
              aria-label="Copy"
              tooltip="Copy"
              onPress={() => {
                void navigator.clipboard?.writeText(entry.text);
              }}
            />
          </ChatMessageActions>
        )}
        {local === undefined || !canAct || onRetrySubmission === undefined ? null : (
          <button
            type="button"
            className="chat-message__local-action"
            onClick={() => onRetrySubmission(local.requestId)}
          >
            Retry
          </button>
        )}
        {local === undefined || !canEdit || onEditSubmission === undefined ? null : (
          <button
            type="button"
            className="chat-message__local-action"
            onClick={() => onEditSubmission(local.requestId)}
          >
            Edit
          </button>
        )}
      </div>
    ) : undefined;
  // Copy only materializes on hover/focus so the resting row is just
  // "Delivered · 2:31 PM" rather than a reserved blank slot.
  const visibleFooter = hovered || canAct ? footer : undefined;
  const metadata = (
    <ChatMessageMetadata
      {...(entry.timestamp === undefined ? {} : { timestamp: <ChatMessageTime timestamp={entry.timestamp} today={today} /> })}
      {...(status === undefined ? {} : { status })}
      {...(visibleFooter === undefined ? {} : { footer: visibleFooter })}
      className="chat-message__metadata"
    />
  );
  return (
    <ChatMessage.User data-slot={local === undefined ? "chat-message-user" : "chat-message-local"}>
      <div
        className="flex flex-col items-end gap-1"
        title={local?.error}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        {entry.attachments.length === 0 ? null : (
          <MessageAttachments
            attachments={entry.attachments}
            {...(local === undefined ? {} : { testId: "local-message-attachments" })}
          />
        )}
        {entry.images.length === 0 ? null : (
          <MessageImages
            images={entry.images}
            {...(local === undefined ? {} : { testId: "local-message-images" })}
          />
        )}
        {entry.text === "" ? null : (
          <ChatMessage.Bubble>
            <ChatMessage.Content>
              <SkillMentionText text={entry.text} names={entry.skills} />
            </ChatMessage.Content>
          </ChatMessage.Bubble>
        )}
        {entry.status === "unknown" ? (
          <InternationalizationProvider
            locale="en"
            overrides={{ en: { "@astryx.chat.status.sending": "Not confirmed" } }}
          >
            {metadata}
          </InternationalizationProvider>
        ) : (
          metadata
        )}
      </div>
    </ChatMessage.User>
  );
}
function ChatMessageTime({ timestamp, today }: { timestamp: number; today?: number }) {
  const value = messageTime(timestamp, today);
  if (value === undefined) return null;
  return (
    <time
      className="chat-message__time"
      data-slot="chat-message-time"
      dateTime={value.iso}
      title={value.full}
    >
      {value.label}
    </time>
  );
}

function RunEntry({
  entry,
  connected,
  openInPanel,
  onFork,
  canFork = true,
  forksAt,
  summaryOf,
  onRetry,
  todo,
  today,
}: {
  entry: Extract<ChatEntry, { kind: "run" }>;
  connected: boolean;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onFork: (entryId: string) => void;
  canFork?: boolean;
  forksAt?: (entryId: string) => ConversationId[];
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  onRetry?: () => Promise<void>;
  todo?: RunTodo;
  today?: number;
}) {
  // Subagent calls anchor cards under the run instead of rows in the CoT.
  const { view: cotWithoutSubagents, subagents } = useMemo(() => splitSubagentCalls(entry.cot), [entry.cot]);
  const cot = useMemo(() => fillToolDetails(cotWithoutSubagents), [cotWithoutSubagents]);
  const answer = cot.answer;
  // A forked message's chip opens the thread in the panel rather than the dialog.
  const forks = entry.forkEntryId === undefined ? [] : (forksAt?.(entry.forkEntryId) ?? []);
  // A settled run's metadata rides in its actions row: the end time first,
  // then Copy/Fork. A textless tail (thinking-only or tool-only last message)
  // still gets the chip/Fork from forkEntryId — the chip shows even when
  // canFork is false (legacy nesting). A settled run with nothing else to act
  // on still shows when it ended.
  const endedAt = cot.phase === "settled" ? entry.endedAt : undefined;
  const showActions =
    cot.phase === "settled" &&
    (endedAt !== undefined ||
      answer !== undefined ||
      (entry.forkEntryId !== undefined && (canFork || forks.length > 0)));
  return (
    <ChatMessage.Assistant>
      <ChatMessage.Body>
        {entry.interrupted ? (
          <p className="mb-1">
            <Token label="interrupted" color="orange" size="sm" />
          </p>
        ) : null}
        <AssistantRunTrajectory view={cot} />
        <SubagentCards tools={subagents} summaryOf={summaryOf} openInPanel={openInPanel} />
        {answer === undefined ? null : (
          <ChatMessage.Content>
            {answer.streaming ? (
              <ChatStreamMarkdown isStreaming>{answer.text}</ChatStreamMarkdown>
            ) : (
              <ChatMarkdown>{answer.text}</ChatMarkdown>
            )}
          </ChatMessage.Content>
        )}
        {entry.failure === undefined ? null : <ChatRunFailure error={entry.failure} onRetry={onRetry} />}
        {!showActions ? null : (
          <ChatMessageActions className="chat-message__actions--persist">
            {endedAt === undefined ? null : (
              <ChatMessageMetadata timestamp={<ChatMessageTime timestamp={endedAt} today={today} />} />
            )}
            {answer === undefined ? null : (
              <ChatMessageActions.Copy
                aria-label="Copy"
                tooltip="Copy"
                onPress={() => {
                  void navigator.clipboard?.writeText(answer.text);
                }}
              />
            )}
            {entry.forkEntryId === undefined ? null : forks.length > 0 ? (
              <button
                type="button"
                className="pigui-fork-chip"
                aria-label={`${forks.length} ${forks.length === 1 ? "fork" : "forks"}`}
                title="Open in Threads"
                disabled={!connected}
                onClick={() => openInPanel(forks[0]!, "threads")}
              >
                <GitFork aria-hidden="true" />
                {forks.length} {forks.length === 1 ? "fork" : "forks"}
              </button>
            ) : canFork ? (
              <ChatMessage.Action
                aria-label="Fork"
                tooltip="Continue from here in a new conversation"
                disabled={!connected}
                onPress={() => onFork(entry.forkEntryId!)}
              >
                <GitFork aria-hidden="true" className="size-4" />
              </ChatMessage.Action>
            ) : null}
          </ChatMessageActions>
        )}
        {/* Last in the run, below the answer: the card never sits between steps. */}
        <TodoCard
          todo={todo?.state}
          writtenThisRun={cot.todoWrittenAtMs !== undefined}
          {...(todo?.updatedAtMs === undefined ? {} : { updatedAtMs: todo.updatedAtMs })}
        />
      </ChatMessage.Body>
    </ChatMessage.Assistant>
  );
}

/**
 * One run's process, cut at Interim Output (ADR-0026 §2): what the model said
 * to the user reads as prose, and the calls and thinking between two such
 * passages fold into one grey row. The phase, clock anchor and steps all come
 * from deriveChat; this only lays them out.
 */
function AssistantRunTrajectory({ view }: { view: CotView }) {
  const segments = useMemo(() => segmentRun(view.steps), [view.steps]);

  if (view.phase === "hidden") {
    return null;
  }

  const ticking = view.phase === "thinking" || view.phase === "acting";

  if (!ticking && segments.length === 0) {
    return null;
  }

  // The last row carries the run's time: the clock while it runs (the row
  // walks the anchor itself at 100ms rather than the page re-deriving the
  // whole view that often), held at the first answer token while the answer
  // streams, and the derived duration once settled (ADR-0030 §6). With no
  // row to carry it, the answer alone stands for the run.
  const elapsed = view.phase === "settled" ? formatElapsed(view.elapsedMs) : undefined;
  const tail = elapsed === undefined ? undefined : view.outcome === "failed" ? `Failed after ${elapsed}` : elapsed;
  const clock = ticking || view.phase === "answering" ? { startedAtMs: view.anchorMs, running: ticking } : undefined;
  // Between rounds no step is live, but the run is.
  const waiting = view.phase === "thinking" ? "Thinking…" : "Working…";
  // A live run always ends in a row; before its first step (or after prose)
  // that is a bare one. Its key is the next segment's, so the step that lands
  // takes the row over instead of adding a second.
  const bareRow = ticking && segments.at(-1)?.kind !== "trace";
  const carrier = bareRow ? segments.length : segments.findLastIndex((segment) => segment.kind === "trace");
  const carried = {
    ...(ticking ? { live: true, waiting } : {}),
    ...(tail === undefined ? {} : { tail }),
    ...(clock === undefined ? {} : { clock }),
  };

  return (
    <ChainOfThought phase={view.phase}>
      {segments.map((segment, index) =>
        segment.kind === "interim" ? (
          <ChatMessage.Content key={segment.key} data-slot="chat-interim-output">
            <ChatMarkdown>{segment.text}</ChatMarkdown>
          </ChatMessage.Content>
        ) : (
          <ChatTraceRow
            key={segment.key}
            steps={segment.steps}
            counted={segment.counted}
            {...(index === carrier ? carried : {})}
          />
        ),
      )}
      {bareRow ? <ChatTraceRow key={`segment-${carrier}`} steps={[]} counted={[]} {...carried} /> : null}
    </ChainOfThought>
  );
}
