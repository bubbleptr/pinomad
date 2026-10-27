// What a graphical client shows for a conversation view, as plain data. The
// derivations follow pi's durable TUI (packages/coding-agent/src/experimental/durable/tui.ts,
// MIT, Earendil Works) so every client tells the same story. Type-only imports keep it browser-safe.
// See docs/licenses/pi.md for the upstream notice.
import type {
  AgentState,
  ConversationView,
  InboxState,
  LiveState,
  TaskGraph,
  TaskGraphNode,
  TaskId,
  UsageState,
} from "@earendil-works/pi-durable";
import type { UserAttachment } from "@pinomad/protocol/attachments.ts";
import type { ImageMimeType, ViewImage } from "@pinomad/protocol/images.ts";
import type { LogicalSubmission } from "@pinomad/protocol/view.ts";
import { stripUserBlocks } from "./skill-blocks.ts";

type Block = {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly ref?: string;
};
type Content = string | readonly Block[];
function imageCountOf(content: Content): number {
  if (typeof content === "string" || !Array.isArray(content)) return 0;
  return content.filter((block) => block.type === "image").length;
}

/** The image blocks of a queued input, in either wire form (ADR-0027); bytes win when both are present. */
function imagesOf(content: Content): ViewImage[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  return content.flatMap((block): ViewImage[] => {
    if (block.type !== "image" || block.mimeType === undefined) return [];
    const mimeType = block.mimeType as ImageMimeType;
    if (typeof block.data === "string" && block.data !== "") return [{ data: block.data, mimeType }];
    if (typeof block.ref === "string" && block.ref !== "") return [{ ref: block.ref, mimeType }];
    return [];
  });
}

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

/** The conversation's agent doc (model, thinking level, cwd). */
export const agentOf = (view: ConversationView): AgentState => (view.docs["pi.agent"] ?? {}) as AgentState;

/** What the conversation is doing beyond the run itself, most specific first; empty when idle or just busy. */
export function statusText(view: ConversationView): string {
  const live = liveOf(view);
  const generation = live.generation;
  const compaction = live.compactions?.[0];
  if (generation?.retry !== undefined) return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
  if (generation?.deferred !== undefined) return "Waiting for deferred response...";
  if (compaction !== undefined) {
    return compaction.retry ? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...` : `Compacting (${compaction.reason})...`;
  }
  return "";
}

export type QueueStatus = "sending" | "sent" | "unknown" | "failed";

export interface QueueItem {
  /** The host inbox id; absent on a local row the host has not admitted yet. */
  readonly id?: number;
  /** The local submission's idempotency key; absent on a host row. */
  readonly requestId?: string;
  readonly mode: "steer" | "followUp" | "write";
  readonly text: string;
  /** Image blocks attached to the queued input; 0 on "write" items. */
  readonly imageCount: number;
  /** Host-stored file attachments on the queued input; 0 on "write" items. */
  readonly attachmentCount: number;
  readonly status: QueueStatus;
  /** Set only on a local row; error explains a failed send. */
  readonly local?: { readonly error?: string };
}

export function queueItems(
  view: ConversationView,
  submissions: readonly LogicalSubmission[] = [],
): QueueItem[] {
  const inbox = (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
  const hostItems = inbox.items.map((item) => {
    const typed = item.mode === "write" ? undefined : stripUserBlocks(item.content as string | readonly Block[]);
    return {
      id: item.id as unknown as number,
      mode: item.mode,
      // The typed text, not the blocks the host wrote around them (ADR-0028, #321).
      text: item.mode === "write" ? `<${String(item.entry.kind)}>` : typed!.text,
      imageCount: item.mode === "write" ? 0 : imageCountOf(item.content as Content),
      attachmentCount: typed?.attachments.length ?? 0,
      // A host inbox row means the host has admitted it; one check.
      status: "sent" as const,
    };
  });
  const hostIds = new Set(hostItems.map((item) => String(item.id)));
  const localItems = submissions.flatMap((submission): QueueItem[] => {
    if (submission.phase === "settled" || submission.placement !== "queue") return [];
    if (submission.conversationId !== undefined && submission.conversationId !== view.conversation.id) return [];
    // The inbox row has already taken over even if the controller has not
    // folded the event into its phase yet.
    if (submission.submissionId !== undefined && hostIds.has(String(submission.submissionId))) return [];
    const status: QueueStatus = submission.phase === "unknown"
      ? "unknown"
      : submission.phase === "failed"
        ? "failed"
        : "sending";
    return [{
      requestId: submission.requestId,
      mode: submission.whenBusy,
      text: submission.text,
      imageCount: submission.images.length,
      attachmentCount: (submission.attachmentDetails ?? submission.attachments).length,
      status,
      local: {
        ...(submission.error === undefined ? {} : { error: submission.error }),
      },
    }];
  });
  return [...hostItems, ...localItems];
}

/** A queued input's original content, for an Edit affordance that withdraws then refills the composer. */
export interface QueuedInput {
  /** What the user typed, without the skill blocks the host prepended (ADR-0028). */
  readonly text: string;
  readonly images: ViewImage[];
  /** The skills the host expanded — the chips an edit restores, sent back as `skills`. */
  readonly skills: readonly string[];
  /** The host-stored files on this queued input, restored as chips on edit. */
  readonly attachments: readonly UserAttachment[];
}

/** The content of a queued steer/follow-up, or undefined for a write or an unknown id. */
export function queuedInput(view: ConversationView, id: number): QueuedInput | undefined {
  const inbox = (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
  const item = inbox.items.find((candidate) => (candidate.id as unknown as number) === id);
  if (item === undefined || (item.mode !== "steer" && item.mode !== "followUp")) return undefined;
  const typed = stripUserBlocks(item.content as string | readonly Block[]);
  return {
    text: typed.text,
    images: imagesOf(item.content as Content),
    skills: typed.skills,
    attachments: typed.attachments,
  };
}

export interface TaskRow {
  readonly id: TaskId;
  readonly depth: number;
  readonly label: string;
}

function describeTask(node: TaskGraphNode): string {
  const state = node.state;
  const status =
    state.status === "waiting"
      ? `waiting on ${state.on.join(", ")}`
      : state.status === "completing"
        ? `completing (${state.outcome})`
        : `${state.status} ${state.phase}`;
  const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
  const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
  return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

export interface UsageRow {
  /** `provider/model` of model responses, or a tool name. */
  readonly key: string;
  readonly input: number;
  readonly output: number;
  readonly cost: number;
}

/** Spend of the shown conversation, as `pi.usage` totals it; failed and aborted attempts count. */
export function usageRows(view: ConversationView): UsageRow[] {
  const usage = view.docs["pi.usage"] as UsageState | undefined;
  if (usage === undefined) return [];
  return [...Object.entries(usage.models), ...Object.entries(usage.tools)].map(([key, value]) => ({
    key,
    input: value.input,
    output: value.output,
    cost: value.cost.total,
  }));
}

/** Live tasks as an indented tree: owned work under its owner, a subagent's work under the call that owns its conversation. */
export function taskRows(graph: TaskGraph): TaskRow[] {
  const nodes = Object.values(graph.tasks);
  const owned = new Set(nodes.flatMap((node) => node.conversations));
  const children = (node: TaskGraphNode) =>
    nodes.filter(
      (candidate) => candidate.owner === node.id || (candidate.owner === undefined && node.conversations.includes(candidate.conversationId)),
    );
  const rows: TaskRow[] = [];
  const visit = (node: TaskGraphNode, depth: number): void => {
    rows.push({ id: node.id, depth, label: describeTask(node) });
    for (const child of children(node)) visit(child, depth + 1);
  };
  for (const node of nodes) if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
  return rows;
}
