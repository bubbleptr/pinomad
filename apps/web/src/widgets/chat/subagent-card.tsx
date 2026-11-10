// The main-area anchor for a delegated task. The card shows the subagent's
// name, status, model, worktree branch, elapsed time, and — while running — what the child is
// doing (the summary's `activity`). The full report lives in the subagent's
// own conversation: the card only names it.
//
// A background call (ADR-0046 §1) returns as soon as the subagent is
// dispatched, so its tool state says nothing about the work: once it went
// through, the card follows the subagent's own summary instead.
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import { conversationName } from "@/entities/conversation/subagent";
import { useNow } from "@/shared/use-now";
import { toolDisplayName, toolTargetFromArgs } from "@pinomad/client/tool-item.ts";
import { pinomadOf } from "@pinomad/client/cot-view.ts";

type CardStatus = "done" | "failed" | "running" | "idle";

const STATUS_TEXT: Record<CardStatus, string> = { done: "Done", failed: "Failed", running: "Running", idle: "Idle" };

/** "12s" under a minute, otherwise "1m 5s". */
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A one-second ticker for the running card's elapsed counter. */
function RunningElapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return <>{elapsedText(now - startedAt)}</>;
}

/** Whether the call asked for `background: true`; arguments still streaming read as no. */
function dispatchedInBackground(tool: ChatToolItem): boolean {
  if (tool.argsText === undefined) return false;
  try {
    const args: unknown = JSON.parse(tool.argsText);
    return typeof args === "object" && args !== null && (args as { background?: unknown }).background === true;
  } catch {
    return false;
  }
}

function SubagentCard({
  tool,
  summary,
  openInPanel,
}: {
  tool: ChatToolItem;
  summary: ConversationSummary | undefined;
  openInPanel: (id: ConversationId) => void;
}) {
  const detail = pinomadOf(tool);
  const pinomad = detail?.kind === "subagent" ? detail : undefined;
  const callStatus: CardStatus =
    tool.state === "output-available" ? "done" : tool.state === "output-error" ? "failed" : "running";
  // Dispatched to the background and the call went through: the work is the
  // subagent's now, and the call's end only marks the handover.
  const background = callStatus === "done" && dispatchedInBackground(tool);
  const status: CardStatus = !background
    ? callStatus
    : summary?.status === "failed"
      ? "failed"
      : summary?.status === undefined
        ? "idle"
        : "running";
  // Before the summary arrives: the call's `name`, else its description or task.
  const name = summary !== undefined ? conversationName(summary) : (toolTargetFromArgs(tool.argsText) ?? "Subagent");
  const startedAt = pinomad?.startedAt;
  const endedAt = pinomad?.endedAt;
  const elapsed =
    startedAt === undefined || background
      ? undefined
      : status === "running"
        ? <RunningElapsed key="elapsed" startedAt={startedAt} />
        : endedAt === undefined
          ? undefined
          : elapsedText(endedAt - startedAt);
  const meta = [
    background ? "Background" : undefined,
    STATUS_TEXT[status],
    summary?.role === undefined ? undefined : `@${summary.role}`,
    pinomad?.model,
    // Its own worktree (ADR-0046 §5): the branch to merge from.
    pinomad?.branch,
    elapsed,
  ].filter((part) => part !== undefined && part !== "");
  return (
    <VStack
      className="pigui-subagent-card rounded-lg border border-border p-3"
      gap={1}
      data-slot="subagent-card"
      data-status={status}
      {...(background ? { "data-background": "" } : {})}
    >
      <HStack gap={2} vAlign="center">
        <StatusDot
          variant={status === "failed" ? "error" : status === "running" ? "success" : "neutral"}
          label={STATUS_TEXT[status]}
          isPulsing={status === "running"}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {pinomad === undefined ? null : (
          <Button label="View" variant="secondary" size="sm" onClick={() => openInPanel(pinomad.conversationId)} />
        )}
      </HStack>
      <div className="text-xs text-muted-foreground tabular-nums">
        {meta.map((part, index) => (index === 0 ? <span key={index}>{part}</span> : <span key={index}> · {part}</span>))}
      </div>
      {status === "running" && summary?.activity !== undefined ? (
        <div className="text-xs text-muted-foreground">
          → {toolDisplayName(summary.activity.tool) ?? summary.activity.tool}
          {summary.activity.target === undefined ? "" : ` ${summary.activity.target}`}
        </div>
      ) : null}
      {callStatus === "failed" && tool.output !== undefined && tool.output !== "" ? (
        <div className="text-xs text-muted-foreground">{tool.output}</div>
      ) : null}
    </VStack>
  );
}

/** One card per subagent call the run made, in call order. */
export function SubagentCards({
  tools,
  summaryOf,
  openInPanel,
}: {
  tools: readonly { key: string; tool: ChatToolItem }[];
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  openInPanel: (id: ConversationId) => void;
}) {
  if (tools.length === 0) return null;
  return (
    <VStack gap={2} className="pigui-subagent-cards">
      {tools.map(({ key, tool }) => {
        const pinomad = pinomadOf(tool);
        return (
          <SubagentCard
            key={key}
            tool={tool}
            summary={pinomad?.kind === "subagent" ? summaryOf?.(pinomad.conversationId) : undefined}
            openInPanel={openInPanel}
          />
        );
      })}
    </VStack>
  );
}
