// Chain of Thought view of a conversation, after Pace's
// entities/session/cot-view.ts (commit 15b9084; ADR-0030). The CotPhase /
// CotStep / CotView types are copied verbatim so the shared/ui/chat
// components compile unchanged; deriveChat is PiNomad's derivation from
// Durable's ConversationView (pi.assistant / pi.tool-result entries plus the
// pi.live doc) instead of Pace's session runtime model.

import type { ConversationId, ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { classify, type PresentationType } from "@pinomad/protocol/presentation.ts";
import { toolDiffStatFromResult } from "./tool-diff-stat.ts";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";

export type CotPhase = "hidden" | "thinking" | "acting" | "answering" | "settled";

export type CotStep =
  | {
      kind: "thinking";
      id: string;
      text: string;
      live: boolean;
      /** Wall time inside this thinking Part; ticks while live. */
      durationMs?: number;
    }
  // Text the model addressed to the user mid-run, reclassified out of the
  // answer bubble once the same Message turned out to hold a Tool Call.
  | { kind: "interim"; id: string; text: string }
  | {
      kind: "tools";
      id: string;
      tools: ChatToolItem[];
      live: boolean;
      /** The call currently streaming or executing, while the burst is live. */
      activeToolCallId?: string;
    };

export type CotView = {
  phase: CotPhase;
  outcome?: "failed";
  /**
   * The Run's single clock anchor: its first surviving model call, as an epoch
   * stamp. Handed to the component so it can walk the clock itself instead of
   * the page re-deriving the whole view every 100ms. Absent until the Run has
   * a Message to anchor on — during a retry gap, most of all.
   */
  anchorMs?: number;
  /** Time from the Run's first model call to the first answer token. */
  elapsedMs?: number;
  /** Steps in Turn order; the last one may still be live. */
  steps: CotStep[];
  /** The answer bubble's text — final, or presumed final while answering. */
  answer?: { text: string; streaming: boolean };
};

export type ChatEntry =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "run"; id: string;
      cot: CotView;
      /** Entry id a fork starts from: the run's last assistant entry, only when settled and not interrupted/failed. */
      forkEntryId?: string;
      interrupted: boolean;
      /** Last assistant stopReason === "error": its errorMessage (or a generic text). */
      failure?: string;
    }
  | { kind: "compaction"; id: string }
  | { kind: "reset"; id: string };

/**
 * Tool rendering the adapter cannot express as data: widgets turn this into a
 * `ChatToolItem.detail` node. The entities layer stays React-free.
 */
export type PinomadToolDetail =
  | { kind: "diff"; patch: string }
  | {
      kind: "subagent";
      conversationId: ConversationId;
      output?: string;
      /** "provider/modelId" the child ran, recorded by the host. */
      model?: string;
      /** Epoch ms the child was created, recorded by the host. */
      startedAt?: number;
      /** The tool result's timestamp — the run's end for elapsed time. */
      endedAt?: number;
    };

/** A tool item that may carry a `pinomad` render payload; what deriveChat produces. */
export type ConversationToolItem = ChatToolItem & { pinomad?: PinomadToolDetail };

/** The `pinomad` payload a tool item may carry; absent on plain tools. */
export function pinomadOf(tool: ChatToolItem): PinomadToolDetail | undefined {
  return (tool as ConversationToolItem).pinomad;
}

type Block = {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly data?: string;
  readonly mimeType?: string;
};

type AssistantMessageLike = {
  readonly role: "assistant";
  readonly content: readonly Block[];
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly timestamp?: number;
};

type ToolResultLike = {
  readonly role: "toolResult";
  readonly toolCallId: string;
  readonly content: string | readonly Block[];
  readonly isError?: boolean;
  readonly details?: unknown;
  readonly timestamp?: number;
};

type UserMessageLike = { readonly role: "user"; readonly content: string | readonly Block[] };

function textOf(content: string | readonly Block[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("");
}

function imagesOf(content: string | readonly Block[]): { data: string; mimeType: string }[] {
  if (typeof content === "string") return [];
  return content.flatMap((block) =>
    block.type === "image" && block.data !== undefined && block.mimeType !== undefined
      ? [{ data: block.data, mimeType: block.mimeType }]
      : [],
  );
}

type ToolImage = { data: string; mimeType: string };

type CallBlock = Block & { readonly type: "toolCall"; readonly id: string; readonly name?: string };

const isCallBlock = (block: Block): block is CallBlock => block.type === "toolCall" && block.id !== undefined;

/** One committed assistant entry, or the run's in-flight partial. */
type RunMessage = {
  readonly id: string;
  readonly msg: AssistantMessageLike;
  /** The `pi.live` generation partial: still streaming. */
  readonly partial?: boolean;
  /**
   * Results keyed by call id, scoped to this message's own calls — providers
   * reuse call ids across rounds, so a run-wide map would hand every round
   * the newest result.
   */
  readonly results: ReadonlyMap<string, ToolResultLike>;
};

type RunDraft = {
  readonly assistants: { id: string; msg: AssistantMessageLike; results: Map<string, ToolResultLike> }[];
  /** Results whose call id no earlier pending call in the draft claims. */
  readonly orphans: Map<string, ToolResultLike>;
  /** Latest message timestamp seen inside the run. */
  lastTs?: number;
};

type Slot = NonNullable<LiveState["tools"]>[number];

// The codemode tool's only argument is a `code` envelope; the detail pane is
// more useful showing the script itself than escaped JSON. Partial envelopes
// while the call streams in stay raw.
function argsTextOf(args: unknown, toolName: string | undefined): string | undefined {
  if (args === undefined) return undefined;
  if (toolName === "codemode" && typeof args === "object" && args !== null) {
    const code = (args as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return JSON.stringify(args);
}

function childConversationId(details: unknown): ConversationId | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const id = (details as { conversationId?: unknown }).conversationId;
  return typeof id === "number" ? (id as ConversationId) : undefined;
}

/** One `pinomad.codemode` nested call, as a child ChatToolItem of the parent card. */
function codemodeChild(
  call: { name: string; args: string; status: string; durationMs?: number; error?: string; details?: unknown },
  parentRunning: boolean,
  toolPresentations: Record<string, PresentationType>,
): ConversationToolItem {
  const state: ChatToolItem["state"] =
    call.status === "ok"
      ? "output-available"
      : call.status === "error"
        ? "output-error"
        : // Stored details freeze at the last publish: a call still "running"
          // when the card settled was cancelled, never still in flight.
          parentRunning && call.status === "running"
          ? "input-available"
          : "output-error";
  const output =
    call.status === "error"
      ? call.error
      : state === "output-error"
        ? "Cancelled"
        : undefined;
  const classified = call.details === undefined ? undefined : classify(toolPresentations[call.name], call.details);
  const pinomad = classified?.type === "pinomad.diff" ? { kind: "diff" as const, patch: classified.value.patch } : undefined;
  return {
    state,
    toolName: call.name,
    argsText: call.args,
    ...(output === undefined ? {} : { output }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    ...(pinomad === undefined ? {} : { pinomad }),
  };
}

function toolItem(
  block: CallBlock,
  message: RunMessage,
  liveSlots: ReadonlyMap<string, Slot>,
  toolPresentations: Record<string, PresentationType>,
): ConversationToolItem {
  const callId = block.id;
  const result = message.results.get(callId);
  const slot = message.partial ? undefined : liveSlots.get(callId);
  const toolName = slot?.name ?? block.name;
  const argsText = argsTextOf(block.arguments, toolName);

  let state: ChatToolItem["state"];
  let output: string | undefined;
  if (result !== undefined) {
    state = result.isError === true ? "output-error" : "output-available";
    output = textOf(result.content);
  } else if (slot?.status === "running") {
    state = "input-available";
    output = slot.output;
  } else if (message.partial === true) {
    state = "input-streaming";
  } else if (message.msg.stopReason !== "toolUse") {
    // Only a tool-calling answer runs its calls; an aborted, failed, or
    // truncated one never does.
    state = "output-error";
    output = "Not run: the answer was interrupted.";
  } else {
    state = "input-available";
    output = slot?.output;
  }

  const details = result?.details ?? slot?.details;
  const classified = details === undefined ? undefined : classify(toolPresentations[toolName ?? ""], details);
  const diffStat =
    result !== undefined && result.isError !== true ? toolDiffStatFromResult({ details: result.details }) : undefined;
  const images = result === undefined ? [] : imagesOf(result.content);
  const child = childConversationId(details);

  let pinomad: PinomadToolDetail | undefined;
  let children: ChatToolItem[] | undefined;
  if (classified?.type === "pinomad.diff") {
    pinomad = { kind: "diff", patch: classified.value.patch };
  } else if (child !== undefined) {
    const detail = details as { model?: unknown; startedAt?: unknown };
    pinomad = {
      kind: "subagent",
      conversationId: child,
      ...(output === undefined ? {} : { output }),
      ...(typeof detail.model === "string" ? { model: detail.model } : {}),
      ...(typeof detail.startedAt === "number" ? { startedAt: detail.startedAt } : {}),
      ...(typeof result?.timestamp === "number" ? { endedAt: result.timestamp } : {}),
    };
  }
  if (classified?.type === "pinomad.codemode") {
    const running = result === undefined;
    children = classified.value.calls.map((call) => codemodeChild(call, running, toolPresentations));
  }

  return {
    state,
    toolCallId: callId,
    ...(toolName === undefined ? {} : { toolName }),
    ...(argsText === undefined ? {} : { argsText }),
    ...(output === undefined ? {} : { output }),
    ...(diffStat === undefined ? {} : { diffStat }),
    ...(images.length === 0 ? {} : { images }),
    ...(children === undefined || children.length === 0 ? {} : { children }),
    ...(pinomad === undefined ? {} : { pinomad }),
  };
}

/** Consecutive Tool Calls in one Message are one step (ADR-0030 §3). */
type MessageSlot = { kind: "thinking"; block: Block } | { kind: "tools"; blocks: CallBlock[] } | { kind: "text"; block: Block };

function slotsOf(content: readonly Block[]): MessageSlot[] {
  const slots: MessageSlot[] = [];
  for (const block of content) {
    if (isCallBlock(block)) {
      const last = slots[slots.length - 1];
      if (last?.kind === "tools") last.blocks.push(block);
      else slots.push({ kind: "tools", blocks: [block] });
    } else if (block.type === "thinking") {
      slots.push({ kind: "thinking", block });
    } else if (block.type === "text") {
      slots.push({ kind: "text", block });
    }
  }
  return slots;
}

function deriveRun(
  id: string,
  draft: RunDraft,
  live: LiveState,
  busy: boolean,
  toolPresentations: Record<string, PresentationType>,
): ChatEntry {
  const liveSlots = new Map<string, Slot>((busy ? live.tools : undefined)?.map((slot) => [slot.callId, slot]) ?? []);
  const partial = busy ? (live.generation?.message as AssistantMessageLike | undefined) : undefined;
  const emptyResults: ReadonlyMap<string, ToolResultLike> = new Map();
  const messages: RunMessage[] = [
    ...draft.assistants.map(({ id: entryId, msg, results }) => ({ id: entryId, msg, results })),
    ...(partial === undefined ? [] : [{ id: "live", msg: partial, partial: true as const, results: emptyResults }]),
  ];
  const latest = messages[messages.length - 1];
  const lastCommitted = draft.assistants[draft.assistants.length - 1];

  const settled = !busy;
  const latestTexts =
    latest === undefined ? [] : latest.msg.content.filter((block) => block.type === "text");
  const answerText = latestTexts.map((block) => block.text ?? "").join("");
  const latestHasCalls = latest?.msg.content.some(isCallBlock) === true;
  // §7: while the Run is live, a Message that holds a Tool Call cannot be
  // answering — its text is Interim Output.
  const answering = answerText !== "" && (settled || !latestHasCalls);

  // A call still owed an execution keeps the phase on acting. Calls inside a
  // non-toolUse answer never ran (they carry the interrupted error instead),
  // so they do not count.
  const pendingCall = (message: RunMessage, block: Block): block is CallBlock =>
    isCallBlock(block) &&
    !message.results.has(block.id) &&
    (message.partial === true || message.msg.stopReason === "toolUse");
  const unexecutedTool = messages.some((message) => message.msg.content.some((block) => pendingCall(message, block)));
  const latestPart = latest?.msg.content[latest.msg.content.length - 1];

  let phase: CotPhase;
  if (settled) phase = "settled";
  else if (answering) phase = "answering";
  else if (unexecutedTool || latestPart !== undefined && isCallBlock(latestPart)) phase = "acting";
  else if (messages.length > 0) phase = "thinking";
  else phase = "hidden";

  const ticking = phase === "thinking" || phase === "acting";
  const steps: CotStep[] = [];

  for (const message of messages) {
    const isLatest = message === latest;
    const content = message.msg.content;
    slotsOf(content).forEach((slot, slotIndex) => {
      if (slot.kind === "tools") {
        const pending = slot.blocks.filter((block) => pendingCall(message, block));
        const stepLive = ticking && pending.length > 0;
        steps.push({
          kind: "tools",
          id: `${message.id}-tools-${slotIndex}`,
          tools: slot.blocks.map((block) => toolItem(block, message, liveSlots, toolPresentations)),
          live: stepLive,
          // The agent executes in order, so the active call is the first unexecuted one.
          ...(stepLive && pending[0] !== undefined ? { activeToolCallId: pending[0].id } : {}),
        });
        return;
      }
      if (slot.kind === "text") {
        if (!(isLatest && answering)) {
          steps.push({ kind: "interim", id: `${message.id}-text-${slotIndex}`, text: slot.block.text ?? "" });
        }
        return;
      }
      // Thinking is a step even with an empty body: providers give summaries,
      // redacted blocks, or nothing at all. Live only while it is the
      // streaming partial's tail block — a later block means it finished.
      const blockIndex = content.indexOf(slot.block);
      steps.push({
        kind: "thinking",
        id: `${message.id}-thinking-${slotIndex}`,
        text: slot.block.thinking ?? "",
        live: ticking && message.partial === true && blockIndex === content.length - 1,
      });
    });
  }

  const interrupted = lastCommitted?.msg.stopReason === "aborted";
  const failed = settled && lastCommitted?.msg.stopReason === "error";
  const anchorMs = messages[0]?.msg.timestamp;
  let elapsedMs: number | undefined;
  if (settled && anchorMs !== undefined) {
    const endMs = answering ? latest?.msg.timestamp : (draft.lastTs ?? latest?.msg.timestamp);
    elapsedMs = endMs === undefined ? undefined : endMs - anchorMs;
  }

  return {
    kind: "run",
    id,
    cot: {
      phase,
      ...(failed === true ? { outcome: "failed" as const } : {}),
      ...(anchorMs === undefined ? {} : { anchorMs }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      steps,
      ...(answering ? { answer: { text: answerText, streaming: latest?.partial === true } } : {}),
    },
    interrupted,
    ...(settled && !interrupted && failed !== true && lastCommitted !== undefined
      ? { forkEntryId: lastCommitted.id }
      : {}),
    ...(failed === true ? { failure: lastCommitted?.msg.errorMessage ?? "The run failed." } : {}),
  };
}

export function deriveChat(
  view: ConversationView,
  toolPresentations: Record<string, PresentationType>,
  busy: boolean,
): ChatEntry[] {
  const items: ChatEntry[] = [];
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  let draft: RunDraft | undefined;
  let runSeq = 0;

  const flush = (busyRun: boolean): void => {
    if (draft === undefined) return;
    if (draft.assistants.length > 0 || draft.orphans.size > 0 || busyRun) {
      const anchor = draft.assistants[0]?.id ?? `open-${runSeq++}`;
      items.push(deriveRun(`run-${anchor}`, draft, live, busyRun, toolPresentations));
    }
    draft = undefined;
  };

  for (const entry of view.entries as readonly EntryRecord[]) {
    const message = entry.model?.[0] as
      | AssistantMessageLike
      | ToolResultLike
      | UserMessageLike
      | undefined;
    const id = String(entry.id);
    if (entry.kind === "pi.user" && message?.role === "user") {
      flush(false);
      items.push({ kind: "user", id, text: textOf(message.content) });
    } else if (entry.kind === "pi.compaction") {
      flush(false);
      items.push({ kind: "compaction", id });
    } else if (entry.kind === "pi.reset") {
      flush(false);
      items.push({ kind: "reset", id });
    } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      draft ??= { assistants: [], orphans: new Map() };
      // A result can outrun its call in the log; the new call claims it.
      const results = new Map<string, ToolResultLike>();
      for (const block of message.content) {
        if (!isCallBlock(block)) continue;
        const orphan = draft.orphans.get(block.id);
        if (orphan !== undefined) {
          draft.orphans.delete(block.id);
          results.set(block.id, orphan);
        }
      }
      draft.assistants.push({ id, msg: message, results });
      draft.lastTs = message.timestamp ?? draft.lastTs;
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && message.toolCallId !== undefined) {
      draft ??= { assistants: [], orphans: new Map() };
      // Call ids repeat across rounds: the newest unclaimed call owns it.
      const target = draft.assistants.findLast(
        (assistant) =>
          !assistant.results.has(message.toolCallId) &&
          assistant.msg.content.some((block) => isCallBlock(block) && block.id === message.toolCallId),
      );
      if (target === undefined) draft.orphans.set(message.toolCallId, message);
      else target.results.set(message.toolCallId, message);
      draft.lastTs = message.timestamp ?? draft.lastTs;
    }
  }

  // The tail group is the live run while the conversation is busy; an empty
  // one still renders (the run exists even before its first message).
  draft ??= busy ? { assistants: [], orphans: new Map() } : undefined;
  flush(busy);
  return items;
}

/**
 * Lift subagent calls out of a run's CoT steps for the anchor cards: calls are
 * identified by tool name (a still-streaming call has no details yet), their
 * order is preserved, and a tools step emptied by the lift is dropped.
 */
export function splitSubagentCalls(view: CotView): { view: CotView; subagents: ChatToolItem[] } {
  const subagents: ChatToolItem[] = [];
  const steps: CotStep[] = [];
  for (const step of view.steps) {
    if (step.kind !== "tools") {
      steps.push(step);
      continue;
    }
    const rest = step.tools.filter((tool) => {
      if (tool.toolName !== "subagent") return true;
      subagents.push(tool);
      return false;
    });
    if (rest.length > 0) steps.push({ ...step, tools: rest });
  }
  return { view: { ...view, steps }, subagents };
}
