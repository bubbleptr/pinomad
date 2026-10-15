// The conversation transcript: an inverted list over deriveChat entries so
// the latest content sits at the bottom and the list follows the stream.
// Subagent calls are lifted out of the chain of thought into small read-only
// cards (no navigation in this milestone).
import { useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Spinner } from "heroui-native";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { MessageImage } from "@pinomad/protocol/images.ts";
import type { PresentationType } from "@pinomad/protocol/presentation.ts";
import { findConversation, type Organized } from "@pinomad/protocol/organization.ts";
import {
  deriveChat,
  pinomadOf,
  retryOf,
  splitSubagentCalls,
  type ChatEntry,
  type CotStep,
  type CotView,
} from "@pinomad/client/cot-view.ts";
import { displayName } from "@pinomad/client/family.ts";
import {
  formatToolDuration,
  toolDisplayName,
  toolTargetFromArgs,
  type ToolItem,
} from "@pinomad/client/tool-item.ts";
import { MarkdownText, MONOSPACE } from "../../shared/ui/markdown.tsx";
import { MessageImages } from "../../entities/image/message-images.tsx";

const OUTPUT_LINE_CAP = 40;

function UserBubble({ entry }: { entry: Extract<ChatEntry, { kind: "user" }> }) {
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "85%", gap: 6 }}>
      <MessageImages images={entry.images} />
      {entry.text === "" ? null : (
        <View
          className="bg-surface-tertiary"
          style={{ borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 }}
        >
          <Text className="text-foreground" style={{ fontSize: 15 }}>
            {entry.text}
          </Text>
        </View>
      )}
    </View>
  );
}

function MutedDivider({ label }: { label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <View style={{ flex: 1, height: 1 }} className="bg-divider" />
      <Text className="text-muted" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 1 }} className="bg-divider" />
    </View>
  );
}

function ToolOutput({ text }: { text: string }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, OUTPUT_LINE_CAP);
  return (
    <View style={{ gap: 2 }}>
      <ScrollView horizontal>
        <Text className="text-muted" style={{ fontFamily: MONOSPACE, fontSize: 12 }}>
          {shown.join("\n")}
        </Text>
      </ScrollView>
      {lines.length > OUTPUT_LINE_CAP ? (
        <Text className="text-muted" style={{ fontSize: 12 }}>
          … {lines.length - OUTPUT_LINE_CAP} more lines
        </Text>
      ) : null}
    </View>
  );
}

function ToolRow({ tool, depth = 0 }: { tool: ToolItem; depth?: number }) {
  const [open, setOpen] = useState(false);
  const running = tool.state === "input-streaming" || tool.state === "input-available";
  const errored = tool.state === "output-error";
  const name = toolDisplayName(tool.toolName) ?? "tool";
  const target = toolTargetFromArgs(tool.argsText);
  const duration = formatToolDuration(tool.durationMs);
  const expandable = tool.argsText !== undefined || tool.output !== undefined;

  return (
    <View style={{ marginLeft: depth * 12, gap: 4 }}>
      <Pressable
        onPress={expandable ? () => setOpen((value) => !value) : undefined}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {running ? <Spinner size="sm" /> : null}
          {errored ? (
            <Text className="text-danger" style={{ fontSize: 13 }}>
              ✕
            </Text>
          ) : null}
          <Text className="text-muted" style={{ fontSize: 13 }} numberOfLines={1}>
            {name}
            {target === undefined ? "" : ` · ${target}`}
            {duration === undefined ? "" : ` · ${duration}`}
            {tool.diffStat === undefined ? "" : ` · +${tool.diffStat.additions} −${tool.diffStat.deletions}`}
          </Text>
        </View>
      </Pressable>
      {open && tool.argsText !== undefined ? <ToolOutput text={tool.argsText} /> : null}
      {open && tool.output !== undefined ? <ToolOutput text={tool.output} /> : null}
      {tool.images !== undefined && tool.images.length > 0 ? (
        <MessageImages images={tool.images} align="start" />
      ) : null}
      {tool.children?.map((child, index) => (
        <ToolRow key={child.toolCallId ?? index} tool={child} depth={depth + 1} />
      ))}
    </View>
  );
}

function StepView({ step }: { step: CotStep }) {
  if (step.kind === "thinking") {
    if (step.text === "") return null;
    return (
      <View style={{ opacity: 0.8 }}>
        <MarkdownText value={step.text} muted />
      </View>
    );
  }
  if (step.kind === "interim") {
    return <MarkdownText value={step.text} />;
  }
  return (
    <View style={{ gap: 6 }}>
      {step.tools.map((tool, index) => (
        <ToolRow key={tool.toolCallId ?? index} tool={tool} />
      ))}
    </View>
  );
}

/** The chain of thought: a live header while the run is in flight, collapsed afterwards. */
function ChainOfThought({ cot }: { cot: CotView }) {
  const [open, setOpen] = useState(false);
  if ((cot.phase === "hidden" || cot.phase === "settled") && cot.steps.length === 0) return null;

  if (cot.phase !== "settled") {
    return (
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Spinner size="sm" />
          <Text className="text-muted" style={{ fontSize: 13 }}>
            {cot.phase === "thinking" ? "Thinking…" : "Working…"}
          </Text>
        </View>
        {cot.steps.map((step) => (
          <StepView key={step.id} step={step} />
        ))}
      </View>
    );
  }

  const summary =
    cot.elapsedMs === undefined || cot.elapsedMs < 1000
      ? `${cot.steps.length} step${cot.steps.length === 1 ? "" : "s"}`
      : `Worked for ${formatToolDuration(cot.elapsedMs)}`;
  return (
    <View style={{ gap: 8 }}>
      <Pressable onPress={() => setOpen((value) => !value)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
        <Text className="text-muted" style={{ fontSize: 13 }}>
          {summary} {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open ? cot.steps.map((step) => <StepView key={step.id} step={step} />) : null}
    </View>
  );
}

function SubagentCard({ tool, organized }: { tool: ToolItem; organized: Organized }) {
  const state = tool.state === "output-available" ? "Done" : tool.state === "output-error" ? "Failed" : "Running";
  // Prefer the child conversation's own label/name when it's known locally.
  const pinomad = pinomadOf(tool);
  const child =
    pinomad?.kind === "subagent" ? findConversation(organized, pinomad.conversationId)?.summary : undefined;
  const label =
    (child === undefined ? undefined : (child.label ?? displayName(child))) ??
    toolTargetFromArgs(tool.argsText) ??
    toolDisplayName(tool.toolName) ??
    "Subagent";
  return (
    <View className="bg-surface-tertiary" style={{ borderRadius: 12, padding: 10, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {state === "Running" ? <Spinner size="sm" /> : null}
        <Text className={state === "Failed" ? "text-danger" : "text-muted"} style={{ fontSize: 12, fontWeight: "600" }}>
          {state}
        </Text>
      </View>
      <Text className="text-foreground" style={{ fontSize: 14 }} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

/** Resubmits the failed run's prompt; the host admits one retry per run id. */
function RetryButton({ onRetry }: { onRetry(): Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      isDisabled={retrying}
      style={{ alignSelf: "flex-start" }}
      onPress={() => {
        setRetrying(true);
        void onRetry().finally(() => setRetrying(false));
      }}
    >
      Retry
    </Button>
  );
}

function RunEntry({
  entry,
  organized,
  onRetry,
}: {
  entry: Extract<ChatEntry, { kind: "run" }>;
  organized: Organized;
  onRetry?: () => Promise<void>;
}) {
  const { view, subagents } = useMemo(() => splitSubagentCalls(entry.cot), [entry.cot]);
  return (
    <View style={{ gap: 10 }}>
      <ChainOfThought cot={view} />
      {subagents.map(({ key, tool }) => (
        <SubagentCard key={key} tool={tool} organized={organized} />
      ))}
      {view.answer === undefined ? null : <MarkdownText value={view.answer.text} />}
      {entry.failure !== undefined ? (
        <>
          <Text className="text-danger" style={{ fontSize: 13 }}>
            {entry.failure}
          </Text>
          {onRetry === undefined ? null : <RetryButton onRetry={onRetry} />}
        </>
      ) : entry.interrupted ? (
        <Text className="text-muted" style={{ fontSize: 13 }}>
          Interrupted
        </Text>
      ) : null}
    </View>
  );
}

function EntryView({
  entry,
  organized,
  onRetry,
}: {
  entry: ChatEntry;
  organized: Organized;
  onRetry?: () => Promise<void>;
}) {
  switch (entry.kind) {
    case "user":
      return <UserBubble entry={entry} />;
    case "run":
      return <RunEntry entry={entry} organized={organized} onRetry={onRetry} />;
    case "compaction":
      return <MutedDivider label="Earlier context summarized" />;
    case "reset":
      return <MutedDivider label="New context" />;
  }
}

export function Transcript({
  conversation,
  toolPresentations,
  organized,
  bottomInset = 0,
  connected = false,
  onRetry,
}: {
  conversation: ConversationView;
  toolPresentations: Record<string, PresentationType>;
  organized: Organized;
  /** Space under the newest message for the floating composer. */
  bottomInset?: number;
  connected?: boolean;
  /**
   * Resubmits the user message the newest run answered, when that run failed —
   * its images go back too. The retry carries a requestId derived from the
   * failed run, so a second tap or another client's retry admits once on the
   * host. Absent on read-only transcripts (subagent conversations).
   */
  onRetry?: (retry: { text: string; images: readonly MessageImage[]; requestId: string }) => Promise<void>;
}) {
  const busy = isBusy(conversation);
  const items = useMemo(() => deriveChat(conversation, toolPresentations, busy), [conversation, toolPresentations, busy]);
  const retry = useMemo(() => retryOf(items), [items]);
  // Inverted list: renderItem order is newest-first so the tail anchors to
  // the composer and scroll-up reveals history.
  const data = useMemo(() => [...items].reverse(), [items]);
  return (
    <FlatList
      style={{ flex: 1 }}
      inverted
      data={data}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item, index }) => (
        <EntryView
          entry={item}
          organized={organized}
          onRetry={
            // Index 0 of the inverted list is the newest entry; retryOf already
            // requires it to be a failed run.
            onRetry !== undefined && connected && retry !== undefined && index === 0
              ? () => onRetry(retry)
              : undefined
          }
        />
      )}
      // Inverted: contentContainerStyle's paddingTop renders at the visual
      // bottom, so the floating composer never covers the newest message.
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, paddingTop: bottomInset, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    />
  );
}
