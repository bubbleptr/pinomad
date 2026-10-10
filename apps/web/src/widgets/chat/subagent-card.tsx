// The main-area anchor for a delegated task. The card shows the label,
// status, model, elapsed time, and — while running — what the child is doing
// (the summary's `activity`). The full report lives in the panel's Tasks
// detail: the card only names it.
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import { displayName } from "@/entities/conversation/family";
import { useNow } from "@/shared/use-now";
import { toolDisplayName, toolTargetFromArgs } from "@/shared/ui/chat/chat-tool";
import { pinomadOf } from "@/entities/conversation/cot-view";

const STATUS_TEXT = { done: "Done", failed: "Failed", running: "Running" } as const;

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

function SubagentCard({
  tool,
  summary,
  openInPanel,
}: {
  tool: ChatToolItem;
  summary: ConversationSummary | undefined;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
}) {
  const detail = pinomadOf(tool);
  const pinomad = detail?.kind === "subagent" ? detail : undefined;
  const status = tool.state === "output-available" ? "done" : tool.state === "output-error" ? "failed" : "running";
  const name = summary !== undefined ? displayName(summary) : (toolTargetFromArgs(tool.argsText) ?? "Subagent");
  const startedAt = pinomad?.startedAt;
  const endedAt = pinomad?.endedAt;
  const meta = [
    STATUS_TEXT[status],
    pinomad?.model,
    startedAt === undefined
      ? undefined
      : status === "running"
        ? <RunningElapsed key="elapsed" startedAt={startedAt} />
        : endedAt === undefined
          ? undefined
          : elapsedText(endedAt - startedAt),
  ];
  return (
    <VStack className="pigui-subagent-card rounded-lg border border-border p-3" gap={1} data-slot="subagent-card" data-status={status}>
      <HStack gap={2} vAlign="center">
        <StatusDot
          variant={status === "failed" ? "error" : status === "running" ? "success" : "neutral"}
          label={STATUS_TEXT[status]}
          isPulsing={status === "running"}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {pinomad === undefined ? null : (
          <Button label="View" variant="ghost" size="sm" onClick={() => openInPanel(pinomad.conversationId, "tasks")} />
        )}
      </HStack>
      <div className="text-xs text-muted">
        {meta.map((part, index) =>
          part === undefined || part === "" ? null : index === 0 ? (
            <span key={index}>{part}</span>
          ) : (
            <span key={index}> · {part}</span>
          ),
        )}
      </div>
      {status === "running" && summary?.activity !== undefined ? (
        <div className="text-xs text-muted">
          → {toolDisplayName(summary.activity.tool) ?? summary.activity.tool}
          {summary.activity.target === undefined ? "" : ` ${summary.activity.target}`}
        </div>
      ) : null}
      {status === "failed" && tool.output !== undefined && tool.output !== "" ? (
        <div className="text-xs text-muted">{tool.output}</div>
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
  tools: readonly ChatToolItem[];
  summaryOf?: (id: ConversationId) => ConversationSummary | undefined;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
}) {
  if (tools.length === 0) return null;
  return (
    <VStack gap={2} className="pigui-subagent-cards">
      {tools.map((tool, index) => {
        const pinomad = pinomadOf(tool);
        return (
          <SubagentCard
            key={tool.toolCallId ?? index}
            tool={tool}
            summary={pinomad?.kind === "subagent" ? summaryOf?.(pinomad.conversationId) : undefined}
            openInPanel={openInPanel}
          />
        );
      })}
    </VStack>
  );
}
