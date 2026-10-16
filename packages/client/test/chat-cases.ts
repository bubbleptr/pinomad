// Shared inputs for the chat.ts derivations: presentation.test.ts asserts on
// these and rust-vectors.ts serializes them for the Rust replay — one table,
// no copies.
import type { ConversationView, EntryRecord, TaskGraph } from "@earendil-works/pi-durable";

export const text = (value: string) => ({ type: "text", text: value });

/** A conversation view carrying `pi.live` and `pi.inbox` docs, no entries. */
export const chatView = (entries: EntryRecord[] = [], live: object = {}, inbox: object[] = []): ConversationView =>
  ({ conversation: { id: 0 }, entries, docs: { "pi.live": live, "pi.inbox": { items: inbox } } }) as unknown as ConversationView;

export interface NamedCase<T> {
  readonly name: string;
  readonly input: T;
}

export const STATUS_CASES: NamedCase<ConversationView>[] = [
  { name: "idle", input: chatView() },
  { name: "run", input: chatView([], { run: {} }) },
  { name: "tools", input: chatView([], { run: {}, tools: [{ callId: "c", name: "logs", status: "running" }] }) },
  {
    name: "retry",
    input: chatView([], { run: {}, generation: { attempt: 1, retry: { at: 0, error: "overloaded" } } }),
  },
  { name: "deferred", input: chatView([], { run: {}, generation: { attempt: 1, deferred: true } }) },
  { name: "compaction", input: chatView([], { compactions: [{ reason: "manual", attempt: 1 }] }) },
  {
    name: "compaction-retry",
    input: chatView([], { compactions: [{ reason: "manual", attempt: 2, retry: { at: 1, error: "x" } }] }),
  },
];

export const AGENT_CASES: NamedCase<ConversationView>[] = [
  { name: "empty", input: chatView() },
  {
    name: "set",
    input: {
      conversation: { id: 0 },
      entries: [],
      docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high", cwd: "/w/project" } },
    } as unknown as ConversationView,
  },
];

export const QUEUE_CASES: NamedCase<ConversationView>[] = [
  {
    name: "steer-followup",
    input: chatView([], {}, [
      { id: 1, mode: "steer", content: "focus" },
      { id: 2, mode: "followUp", content: [text("then this")] },
    ]),
  },
  {
    name: "images",
    input: chatView([], {}, [
      {
        id: 1,
        mode: "followUp",
        content: [text("look"), { type: "image", data: "aGk=", mimeType: "image/png" }, { type: "image", data: "aGk=", mimeType: "image/png" }],
      },
      { id: 2, mode: "write", entry: { kind: "pi.note" } },
    ]),
  },
  { name: "empty", input: chatView() },
];

export const USAGE_CASES: NamedCase<ConversationView>[] = [
  {
    name: "model-and-tool",
    input: {
      conversation: { id: 0 },
      entries: [],
      docs: {
        "pi.usage": {
          models: { "faux/faux-1": { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.002 } } },
          tools: { search_logs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } },
        },
      },
    } as unknown as ConversationView,
  },
  { name: "empty", input: chatView() },
];

export const TASK_GRAPH_CASES: NamedCase<TaskGraph>[] = [
  {
    name: "tree",
    input: {
      tasks: {
        "1": {
          id: 1,
          kind: "pi.generation",
          conversationId: 0,
          background: false,
          abortRequested: false,
          state: { status: "waiting", phase: "tools", on: [2], policy: "all" },
          conversations: [],
        },
        "2": {
          id: 2,
          kind: "pi.tool",
          conversationId: 0,
          owner: 1,
          background: false,
          abortRequested: false,
          state: { status: "running", phase: "run" },
          conversations: [5],
        },
        "3": {
          id: 3,
          kind: "pi.generation",
          conversationId: 5,
          background: false,
          abortRequested: true,
          state: { status: "running", phase: "request" },
          conversations: [],
        },
      },
    } as unknown as TaskGraph,
  },
];

export const IS_BUSY_CASES: NamedCase<ConversationView>[] = [
  { name: "idle", input: chatView() },
  { name: "run", input: chatView([], { run: {} }) },
  { name: "run-null", input: chatView([], { run: null }) },
  { name: "no-live", input: { conversation: { id: 0 }, entries: [], docs: {} } as unknown as ConversationView },
];
