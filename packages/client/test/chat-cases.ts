// Shared inputs for the chat.ts derivations: presentation.test.ts asserts on
// these and rust-vectors.ts serializes them for the Rust replay — one table,
// no copies.
import type { ConversationView, EntryRecord, TaskGraph } from "@earendil-works/pi-durable";
import { attachmentBlock } from "@pinomad/protocol/attachments.ts";
import { attached } from "./attachment-blocks-cases.ts";
import { block } from "./skill-blocks-cases.ts";

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
  {
    name: "images-ref",
    input: chatView([], {}, [
      {
        id: 1,
        mode: "steer",
        content: [
          text("look"),
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "image", ref: "5f2a", mimeType: "image/jpeg" },
        ],
      },
    ]),
  },
  {
    // Queued `$review` messages as the host stored them (ADR-0028).
    name: "skill-blocks",
    input: chatView([], {}, [
      { id: 1, mode: "steer", content: `${block("review", "Review steps.")}\n\n$review now` },
      {
        id: 2,
        mode: "followUp",
        content: [text(`${block("review", "Review steps.")}\n\nlook $review`), { type: "image", data: "aGk=", mimeType: "image/png" }],
      },
    ]),
  },
  {
    name: "attachments",
    input: chatView([], {}, [
      {
        id: 1,
        mode: "steer",
        content: [text("look"), text(attachmentBlock([attached({ name: 'a&b<c>d"e.txt' })])), { type: "image", data: "aGk=", mimeType: "image/png" }],
      },
      { id: 2, mode: "followUp", content: [text(attachmentBlock([attached({ name: "only.txt" })]))] },
    ]),
  },
  { name: "empty", input: chatView() },
];

export interface QueuedInputCase {
  readonly view: ConversationView;
  readonly id: number;
}

export const QUEUED_INPUT_CASES: NamedCase<QueuedInputCase>[] = [
  {
    name: "steer",
    input: {
      view: chatView([], {}, [{ id: 1, mode: "steer", content: "focus" }]),
      id: 1,
    },
  },
  {
    name: "followUp",
    input: {
      view: chatView([], {}, [{ id: 1, mode: "followUp", content: [text("then this")] }]),
      id: 1,
    },
  },
  {
    name: "images",
    input: {
      view: chatView([], {}, [
        {
          id: 4,
          mode: "followUp",
          content: [
            text("look"),
            { type: "image", data: "aGk=", mimeType: "image/png" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ],
        },
      ]),
      id: 4,
    },
  },
  {
    name: "images-ref",
    input: {
      view: chatView([], {}, [
        {
          id: 6,
          mode: "steer",
          content: [
            text("look"),
            { type: "image", data: "aGk=", mimeType: "image/png" },
            { type: "image", ref: "5f2a", mimeType: "image/jpeg" },
          ],
        },
      ]),
      id: 6,
    },
  },
  {
    name: "skill-blocks",
    input: {
      view: chatView([], {}, [
        {
          id: 3,
          mode: "followUp",
          content: [text(`${block("review", "Review steps.")}\n\n$review then x`), { type: "image", data: "aGk=", mimeType: "image/png" }],
        },
      ]),
      id: 3,
    },
  },
  {
    name: "attachments",
    input: {
      view: chatView([], {}, [
        {
          id: 5,
          mode: "followUp",
          content: [text("look"), text(attachmentBlock([attached()])), { type: "image", data: "aGk=", mimeType: "image/png" }],
        },
        { id: 6, mode: "steer", content: [text(attachmentBlock([attached({ name: "only.txt" })]))] },
      ]),
      id: 5,
    },
  },
  {
    name: "write",
    input: {
      view: chatView([], {}, [{ id: 2, mode: "write", entry: { kind: "pi.note" } }]),
      id: 2,
    },
  },
  {
    name: "future-mode",
    input: {
      view: chatView([], {}, [{ id: 5, mode: "later", content: "not a steer yet" }]),
      id: 5,
    },
  },
  {
    name: "missing",
    input: {
      view: chatView([], {}, [{ id: 1, mode: "steer", content: "focus" }]),
      id: 99,
    },
  },
  {
    name: "no-inbox",
    input: {
      view: { conversation: { id: 0 }, entries: [], docs: {} } as unknown as ConversationView,
      id: 1,
    },
  },
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
