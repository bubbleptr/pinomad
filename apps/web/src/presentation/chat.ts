// What a graphical client shows for a conversation view, as plain data. The
// derivations follow pi's durable TUI (packages/coding-agent/src/experimental/durable/tui.ts,
// MIT, Earendil Works) so every client tells the same story. Type-only imports keep it browser-safe.
import type {
  ConversationView,
  InboxState,
  LiveState,
  TaskGraph,
  TaskGraphNode,
  TaskId,
  UsageState,
} from "@earendil-works/pi-durable";

type Block = {
  readonly type: string;
  readonly text?: string;
};
type Message = { readonly role: string; readonly content: string | readonly Block[] };

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

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

export interface QueueItem {
  readonly id: number;
  readonly mode: "steer" | "followUp" | "write";
  readonly text: string;
}

export function queueItems(view: ConversationView): QueueItem[] {
  const inbox = (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
  return inbox.items.map((item) => ({
    id: item.id as unknown as number,
    mode: item.mode,
    text: item.mode === "write" ? `<${String(item.entry.kind)}>` : textOf(item.content as Message["content"]),
  }));
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
