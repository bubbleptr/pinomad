// ChatEntry rendering, after Pace's widgets/live-chat/live-chat-message.tsx:
// a user bubble, then one Assistant message per run — its Chain of Thought,
// the answer, and the settled actions row (Copy + Fork, no thumbs).
import { ChatSystemMessage } from "@astryxdesign/core/Chat";
import { Token } from "@astryxdesign/core/Token";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ChatEntry, CotView } from "@/entities/conversation/cot-view";
import { useMemo } from "react";
import { ChatChainOfThought as ChainOfThought } from "@/shared/ui/chat/chat-chain-of-thought";
import { ChatMarkdown, ChatStreamMarkdown } from "@/shared/ui/chat/chat-markdown";
import { ChatMessage, ChatMessageActions } from "@/shared/ui/chat/chat-message";
import { ChatRunFailure } from "@/shared/ui/chat/chat-run-failure";
import { ChatThoughtMarkdown } from "@/shared/ui/chat/chat-thought-markdown";
import { ChatThoughtStep } from "@/shared/ui/chat/chat-thought-step";
import { ChatToolStep } from "@/shared/ui/chat/chat-tool-step";
import { GitBranch } from "@/shared/ui/icons";
import { fillToolDetails } from "./tool-detail.tsx";

export function ChatEntryView({
  entry,
  connected,
  openInPanel,
  onFork,
  canFork = true,
  forkAt,
}: {
  entry: ChatEntry;
  connected: boolean;
  /** Threads and tasks reached from a transcript open in the side panel. */
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onFork: (entryId: string) => void;
  /** False inside a fork or subagent conversation: depth is one (ADR-0019 §2). */
  canFork?: boolean;
  /** Resolves the fork already anchored at an entry, if the message has one (ADR-0019 §3). */
  forkAt?: (entryId: string) => ConversationId | undefined;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <ChatMessage.User>
          <div className="flex flex-col items-end gap-1">
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
          forkAt={forkAt}
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
  forkAt,
}: {
  entry: Extract<ChatEntry, { kind: "run" }>;
  connected: boolean;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  onFork: (entryId: string) => void;
  canFork?: boolean;
  forkAt?: (entryId: string) => ConversationId | undefined;
}) {
  // Subagent cards always open as tasks; only the Fork action picks threads.
  const cot = useMemo(() => fillToolDetails(entry.cot, (id) => openInPanel(id, "tasks")), [entry.cot, openInPanel]);
  const answer = cot.answer;
  // A message already forked reopens that fork rather than starting a second one.
  const existingFork = entry.forkEntryId === undefined ? undefined : forkAt?.(entry.forkEntryId);
  // A settled run's actions ride on its answer when it has one; a textless tail
  // (thinking-only or tool-only last message) still gets Fork from forkEntryId.
  const showActions = cot.phase === "settled" && (answer !== undefined || (canFork && entry.forkEntryId !== undefined));
  return (
    <ChatMessage.Assistant>
      <ChatMessage.Body>
        {entry.interrupted ? (
          <p className="mb-1">
            <Token label="interrupted" color="orange" size="sm" />
          </p>
        ) : null}
        <AssistantRunTrajectory view={cot} />
        {answer === undefined ? null : (
          <ChatMessage.Content>
            {answer.streaming ? (
              <ChatStreamMarkdown isStreaming>{answer.text}</ChatStreamMarkdown>
            ) : (
              <ChatMarkdown>{answer.text}</ChatMarkdown>
            )}
          </ChatMessage.Content>
        )}
        {entry.failure === undefined ? null : <ChatRunFailure error={entry.failure} />}
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
            {entry.forkEntryId === undefined || !canFork ? null : (
              <ChatMessage.Action
                aria-label="Fork"
                tooltip={existingFork === undefined ? "Continue from here in a new conversation" : "Open the fork from here"}
                disabled={!connected}
                onPress={() =>
                  existingFork === undefined ? onFork(entry.forkEntryId!) : openInPanel(existingFork, "threads")
                }
              >
                <GitBranch aria-hidden="true" className="size-4" />
              </ChatMessage.Action>
            )}
          </ChatMessageActions>
        )}
      </ChatMessage.Body>
    </ChatMessage.Assistant>
  );
}

/**
 * One Active Run's Chain of Thought, as Pace's AssistantRunTrajectory: the
 * phase, clock anchor and steps all come from deriveChat; this only lays them
 * out (ADR-0030 §1).
 */
function AssistantRunTrajectory({ view }: { view: CotView }) {
  if (view.phase === "hidden") {
    return null;
  }

  const ticking = view.phase === "thinking" || view.phase === "acting";

  // Nothing measured and nothing to disclose: a bare "Worked" header would be
  // chrome with nothing behind it.
  if (!ticking && !view.steps.length && view.elapsedMs === undefined) {
    return null;
  }

  return (
    <ChainOfThought
      // While the clock runs the component owns it: it walks the Run's anchor
      // at 100ms rather than the page re-deriving the whole view that often.
      // Every other phase hands over the frozen number (ADR-0030 §6).
      {...(ticking ? { startedAtMs: view.anchorMs } : { elapsedMs: view.elapsedMs })}
      hasSteps={view.steps.length > 0}
      phase={view.phase}
      outcome={view.outcome}
    >
      <ChainOfThought.Steps>
        {view.steps.map((step) => (
          <ChainOfThought.Step key={step.id}>
            {step.kind === "thinking" ? (
              <ChatThoughtStep step={step} />
            ) : step.kind === "tools" ? (
              <ChatToolStep step={step} />
            ) : (
              // Interim Output is what the model said to the user, so it reads
              // a shade darker than the steps around it (ADR-0030 §7).
              <div className="chain-of-thought__interim" data-slot="chat-interim-output">
                <ChatThoughtMarkdown text={step.text} />
              </div>
            )}
          </ChainOfThought.Step>
        ))}
      </ChainOfThought.Steps>
    </ChainOfThought>
  );
}
