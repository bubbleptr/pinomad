// ChatEntry rendering, after Pace's widgets/live-chat/live-chat-message.tsx:
// a user bubble, then one Assistant message per run — its folded process and
// Interim Output, the answer, the settled actions row (Copy + Fork, no
// thumbs), and on the newest run the todo card (ADR-0026).
import { ChatSystemMessage } from "@astryxdesign/core/Chat";
import { Token } from "@astryxdesign/core/Token";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { TodoState } from "@pinomad/protocol/presentation.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { splitSubagentCalls, type ChatEntry, type CotView } from "@pinomad/client/cot-view.ts";
import { useMemo } from "react";
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
import { MessageImages } from "../../entities/image/message-images.tsx";
import { GitBranch } from "@/shared/ui/icons";
import { SubagentCards } from "./subagent-card.tsx";
import { fillToolDetails } from "./tool-detail.tsx";

export function ChatEntryView({
  entry,
  connected,
  openInPanel,
  onFork,
  canFork = true,
  forksAt,
  summaryOf,
  onRetry,
  todo,
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
  /** The conversation's todo list — handed to the newest run only, so one card shows. */
  todo?: TodoState;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <ChatMessage.User>
          <div className="flex flex-col items-end gap-1">
            {entry.images.length === 0 ? null : <MessageImages images={entry.images} />}
            {entry.text === "" ? null : (
              <>
                <ChatMessage.Bubble>
                  <ChatMessage.Content>{entry.text}</ChatMessage.Content>
                </ChatMessage.Bubble>
                <ChatMessageActions className="shrink-0">
                  <ChatMessageActions.Copy
                    aria-label="Copy"
                    tooltip="Copy"
                    onPress={() => {
                      void navigator.clipboard?.writeText(entry.text);
                    }}
                  />
                </ChatMessageActions>
              </>
            )}
          </div>
        </ChatMessage.User>
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
        />
      );
    case "compaction":
      return <ChatSystemMessage variant="divider">Earlier context summarized</ChatSystemMessage>;
    case "reset":
      return <ChatSystemMessage variant="divider">New context</ChatSystemMessage>;
  }
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
}: {
  entry: Extract<ChatEntry, { kind: "run" }>;
  connected: boolean;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onFork: (entryId: string) => void;
  canFork?: boolean;
  forksAt?: (entryId: string) => ConversationId[];
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  onRetry?: () => Promise<void>;
  todo?: TodoState;
}) {
  // Subagent calls anchor cards under the run instead of rows in the CoT.
  const { view: cotWithoutSubagents, subagents } = useMemo(() => splitSubagentCalls(entry.cot), [entry.cot]);
  const cot = useMemo(() => fillToolDetails(cotWithoutSubagents), [cotWithoutSubagents]);
  const answer = cot.answer;
  // A forked message's chip opens the thread in the panel rather than the dialog.
  const forks = entry.forkEntryId === undefined ? [] : (forksAt?.(entry.forkEntryId) ?? []);
  // A settled run's actions ride on its answer when it has one; a textless tail
  // (thinking-only or tool-only last message) still gets the chip/Fork from
  // forkEntryId — the chip shows even when canFork is false (legacy nesting).
  const showActions =
    cot.phase === "settled" && (answer !== undefined || (entry.forkEntryId !== undefined && (canFork || forks.length > 0)));
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
                <GitBranch aria-hidden="true" />
                {forks.length} {forks.length === 1 ? "fork" : "forks"}
              </button>
            ) : canFork ? (
              <ChatMessage.Action
                aria-label="Fork"
                tooltip="Continue from here in a new conversation"
                disabled={!connected}
                onPress={() => onFork(entry.forkEntryId!)}
              >
                <GitBranch aria-hidden="true" className="size-4" />
              </ChatMessage.Action>
            ) : null}
          </ChatMessageActions>
        )}
        {/* Last in the run, below the answer: the card never sits between steps. */}
        <TodoCard todo={todo} {...(cot.todoWrittenAtMs === undefined ? {} : { writtenAtMs: cot.todoWrittenAtMs })} />
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

  // A settled run's duration rides on its last trace row; with no row to
  // carry it, the answer alone stands for the run.
  const elapsed = view.phase === "settled" ? formatElapsed(view.elapsedMs) : undefined;
  const tail = elapsed === undefined ? undefined : view.outcome === "failed" ? `Failed after ${elapsed}` : elapsed;
  const lastTrace = segments.findLastIndex((segment) => segment.kind === "trace");

  return (
    <ChainOfThought
      // While the clock runs the component owns it: it walks the Run's anchor
      // at 100ms rather than the page re-deriving the whole view that often.
      // Settled, the frozen number rides on the last row instead (ADR-0030 §6).
      {...(ticking ? { startedAtMs: view.anchorMs } : {})}
      phase={view.phase}
    >
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
            live={segment.live}
            {...(index === lastTrace && tail !== undefined ? { tail } : {})}
          />
        ),
      )}
    </ChainOfThought>
  );
}
