// Shared deriveChat inputs: cot-view.test.ts asserts on these cases and
// rust-vectors.ts serializes the same inputs for the Rust replay — one table,
// no copies. Entry ids come from a module counter so every case is stable.
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { PresentationType } from "@pinomad/protocol/presentation.ts";
import type { LogicalSubmission } from "@pinomad/protocol/view.ts";
import { attachmentBlock } from "@pinomad/protocol/attachments.ts";
import { deriveChat, type ChatEntry, type CotView } from "../src/cot-view.ts";
import { attached } from "./attachment-blocks-cases.ts";
import { block } from "./skill-blocks-cases.ts";

let nextId = 1;
export const entry = (kind: string, message?: unknown): EntryRecord =>
  ({ id: nextId++, conversationId: 0, kind, ...(message === undefined ? {} : { model: [message] }) }) as unknown as EntryRecord;
export const user = (content: string | unknown[], timestamp = 0) => entry("pi.user", { role: "user", content, timestamp });
export const assistant = (content: unknown[], stopReason = "stop", timestamp = 0, extra: object = {}) =>
  entry("pi.assistant", { role: "assistant", content, stopReason, timestamp, ...extra });
export const result = (callId: string, name: string, output: string, isError = false, details?: unknown, timestamp = 0) =>
  entry("pi.tool-result", {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text: output }],
    isError,
    timestamp,
    ...(details === undefined ? {} : { details }),
  });
export const text = (value: string) => ({ type: "text", text: value });
export const thinking = (value: string) => ({ type: "thinking", thinking: value });
export const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
export const image = (data: string, mimeType: string) => ({ type: "image", data, mimeType });
export const imageRef = (ref: string, mimeType: string) => ({ type: "image", ref, mimeType });
export const view = (entries: EntryRecord[], live: object = {}): ConversationView =>
  ({ conversation: { id: 0 }, entries, docs: { "pi.live": live } }) as unknown as ConversationView;
export const runs = (entries: ChatEntry[]) => entries.filter((item) => item.kind === "run");

export interface DeriveChatCase {
  readonly name: string;
  readonly view: ConversationView;
  readonly busy: boolean;
  readonly presentations?: Record<string, PresentationType>;
  readonly submissions?: readonly LogicalSubmission[];
}

const local = (overrides: Partial<LogicalSubmission> = {}): LogicalSubmission => ({
  requestId: "local-1",
  text: "local hello",
  whenBusy: "followUp",
  placement: "conversation",
  phase: "inFlight",
  images: [],
  skills: [],
  attachments: [],
  ...overrides,
});

export const failed = (errorMessage = "HTTP 429 quota exceeded") =>
  assistant([text("")], "error", 0, { errorMessage });

export const DERIVE_CHAT_CASES: DeriveChatCase[] = [
  {
    name: "settled-simple",
    view: view([user("hi"), assistant([text("hello")])]),
    busy: false,
  },
  {
    name: "settled-run",
    view: view([
      user("go"),
      assistant([thinking("plan"), call("c1", "read", { path: "a.ts" }), call("c2", "read", { path: "b.ts" })], "toolUse"),
      result("c1", "read", "A"),
      result("c2", "read", "B"),
      assistant([text("checking next"), call("c3", "bash", { command: "ls" })], "toolUse"),
      result("c3", "bash", "ok"),
      assistant([text("done")]),
    ]),
    busy: false,
  },
  {
    // The run reads as the model that answered last: a mid-run switch
    // (retry on another model) shows the new one.
    name: "run-model",
    view: view([
      user("go"),
      assistant([call("c1", "read", { path: "a.ts" })], "toolUse", 0, { provider: "openai", model: "gpt-5" }),
      result("c1", "read", "A"),
      assistant([text("done")], "stop", 0, { provider: "anthropic", model: "claude-opus-5-5" }),
    ]),
    busy: false,
  },
  {
    name: "live-thinking",
    view: view([user("hi")], { run: {}, generation: { attempt: 1, message: { role: "assistant", content: [thinking("che")] } } }),
    busy: true,
  },
  {
    name: "live-acting",
    view: view([user("go"), assistant([call("c1", "logs", {})], "toolUse")], {
      run: {},
      tools: [{ callId: "c1", name: "logs", status: "running" }],
    }),
    busy: true,
  },
  {
    name: "live-answering",
    view: view([user("hi")], { run: {}, generation: { attempt: 1, message: { role: "assistant", content: [text("hel")] } } }),
    busy: true,
  },
  {
    name: "live-streaming-call",
    view: view([user("go")], {
      run: {},
      generation: { attempt: 1, message: { role: "assistant", content: [call("c1", "read", { path: "a" })] } },
    }),
    busy: true,
  },
  {
    name: "interrupted",
    view: view([user("go"), assistant([call("c1", "logs", {})], "aborted")]),
    busy: false,
  },
  {
    name: "failed",
    view: view([user("go"), assistant([text("")], "error", 0, { errorMessage: "HTTP 429 quota exceeded" })]),
    busy: false,
  },
  {
    name: "diff",
    view: view([
      user("go"),
      assistant([call("c1", "edit", { path: "a.ts" })], "toolUse"),
      result("c1", "edit", "edited a.ts", false, { patch: "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n" }),
    ]),
    busy: false,
    presentations: { edit: "pinomad.diff" },
  },
  {
    name: "diff-nonconforming",
    view: view([
      user("go"),
      assistant([call("c1", "edit", { path: "a.ts" })], "toolUse"),
      result("c1", "edit", "edited", false, { notAPatch: true }),
    ]),
    busy: false,
    presentations: { edit: "pinomad.diff" },
  },
  {
    name: "codemode",
    view: view([
      user("go"),
      assistant([call("c1", "codemode", { code: "await tools.bash({})" })], "toolUse"),
      result("c1", "codemode", "script result", false, {
        code: "await tools.bash({})",
        calls: [
          { name: "bash", args: "{}", status: "ok", durationMs: 10 },
          { name: "read", args: "{}", status: "running" },
          { name: "edit", args: "{}", status: "error", error: "conflict" },
        ],
      }),
    ]),
    busy: false,
    presentations: { codemode: "pinomad.codemode" },
  },
  {
    name: "codemode-live",
    view: view([user("go"), assistant([call("c1", "codemode", { code: "x" })], "toolUse")], {
      run: {},
      tools: [{ callId: "c1", name: "codemode", status: "running" }],
      nestedTools: [
        { callId: "c1/1", name: "read", parentCallId: "c1", parentTaskId: 9, taskId: 10, status: "running", arguments: { path: "a.txt" } },
        {
          callId: "c1/2",
          name: "bash",
          parentCallId: "c1",
          parentTaskId: 9,
          taskId: 11,
          status: "done",
          arguments: { command: "exit 3" },
          summary: { isError: true, durationMs: 5, error: "Command exited with code 3" },
        },
        { callId: "c1/3", name: "pi.codemode.classify", parentCallId: "c1", parentTaskId: 9, taskId: 12, status: "done", arguments: {} },
        // Another tool's nested call and a pi.* internal stay off this card.
        { callId: "c9/1", name: "read", parentCallId: "c9", parentTaskId: 99, taskId: 13, status: "running", arguments: {} },
      ],
    }),
    busy: true,
    presentations: { codemode: "pinomad.codemode" },
  },
  {
    name: "codemode-legacy",
    view: view([
      user("go"),
      assistant([call("c1", "codemode", { code: "x" })], "toolUse"),
      result("c1", "codemode", "ok", false, {
        code: "x",
        calls: [
          { name: "read", args: "{}", status: "running" },
          { name: "edit", args: "{}", status: "ok", details: { patch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" } },
        ],
      }),
    ]),
    busy: false,
    presentations: { codemode: "pinomad.codemode", edit: "pinomad.diff" },
  },
  {
    name: "subagent-live",
    view: view([user("go"), assistant([call("c1", "subagent", { task: "survey" })], "toolUse")], {
      run: {},
      tools: [{ callId: "c1", name: "subagent", status: "running", details: { conversationId: 7, model: "faux/faux-1", startedAt: 1000 } }],
    }),
    busy: true,
  },
  {
    name: "subagent-done",
    view: view([
      user("go"),
      assistant([call("c1", "subagent", { task: "survey" })], "toolUse"),
      result("c1", "subagent", "report", false, { conversationId: 9, model: "faux/faux-1", startedAt: 1000 }, 4000),
    ]),
    busy: false,
  },
  {
    name: "tool-result-images",
    view: view([
      user("go"),
      assistant([call("c1", "mcp__shot__capture", {})], "toolUse"),
      entry("pi.tool-result", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "mcp__shot__capture",
        content: [text("captured"), image("aGk=", "image/png")],
        isError: false,
        timestamp: 0,
      }),
    ]),
    busy: false,
  },
  {
    name: "user-images",
    view: view([
      user([text("look"), image("aGk=", "image/png")]),
      assistant([text("seen")]),
      user([image("aGk=", "image/png")]),
      assistant([text("again")]),
    ]),
    busy: false,
  },
  {
    // A `$review` message as the host stores it (ADR-0028): the bubble shows
    // only what the user typed; the images still follow as their own blocks.
    name: "user-skill-blocks",
    view: view([
      user(`${block("review", "Review steps.")}\n\n$review do x`),
      assistant([text("reviewed")]),
      user([text(`${block("review", "Review steps.")}\n\nlook $review`), image("aGk=", "image/png")]),
      assistant([text("seen")]),
    ]),
    busy: false,
  },
  {
    // A string message ending in a valid block has no block boundary, so it is
    // still regular text.
    name: "user-string-attachment-block",
    view: view([user(attachmentBlock([attached()])), assistant([text("seen")])]),
    busy: false,
  },
  {
    name: "user-text-block-embedded-attachment",
    view: view([
      user([text(`before ${attachmentBlock([attached()])} after`)]),
      assistant([text("seen")]),
    ]),
    busy: false,
  },
  {
    // The host appends an attachments block as its own text block (#321); the
    // bubble shows the typed text and chips, never the raw block.
    name: "user-attachments",
    view: view([
      user([text("look"), text(attachmentBlock([attached({ name: 'a&b<c>d"e.txt' })])), image("aGk=", "image/png")]),
      assistant([text("seen")]),
      user([text(attachmentBlock([attached({ name: "only.txt" })])), image("aGk=", "image/png")]),
      assistant([text("again")]),
    ]),
    busy: false,
  },
  {
    // A tool result that happens to contain the exact block is data, not a
    // host block: textOf stays generic and the output stays visible.
    name: "tool-result-attachment-block",
    view: view([
      user("go"),
      assistant([call("c1", "read", { path: "notes.txt" })], "toolUse"),
      entry("pi.tool-result", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [text(attachmentBlock([attached()]))],
        isError: false,
        timestamp: 0,
      }),
      assistant([text("done")]),
    ]),
    busy: false,
  },
  {
    name: "boundaries",
    view: view([
      user("one"),
      assistant([text("first")]),
      entry("pi.compaction", { role: "user", content: "summary" }),
      entry("pi.reset"),
      user("two"),
      assistant([text("second")]),
    ]),
    busy: false,
  },
  {
    name: "anchor",
    view: view([
      user("go"),
      assistant([call("c1", "logs", {})], "toolUse", 1000),
      result("c1", "logs", "ok", false, undefined, 3000),
      assistant([text("done")], "stop", 5000),
    ]),
    busy: false,
  },
  {
    name: "dup-call-id",
    view: view([
      user("go"),
      assistant([call("c1", "read", { path: "a" })], "toolUse"),
      result("c1", "read", "A"),
      assistant([call("c1", "read", { path: "b" })], "toolUse"),
      result("c1", "read", "B"),
      assistant([text("done")]),
    ]),
    busy: false,
  },
  {
    name: "dup-call-id-live",
    view: view(
      [
        user("go"),
        assistant([call("c1", "read", { path: "a" })], "toolUse"),
        result("c1", "read", "A"),
        assistant([call("c1", "read", { path: "b" })], "toolUse"),
      ],
      { run: {}, tools: [{ callId: "c1", name: "read", status: "running" }] },
    ),
    busy: true,
  },
  {
    name: "aborted-not-pending",
    view: view([user("go"), assistant([call("c1", "bash", { command: "x" })], "aborted")], {
      run: {},
      generation: { attempt: 1, message: { role: "assistant", content: [thinking("retrying")] } },
    }),
    busy: true,
  },
  {
    name: "interim-before-tools",
    view: view([user("go"), assistant([text("Checking the logs"), call("c1", "bash", { command: "ls" })], "toolUse")], {
      run: {},
      tools: [{ callId: "c1", name: "bash", status: "running" }],
    }),
    busy: true,
  },
  {
    name: "elapsed-no-answer",
    view: view([
      user("go"),
      assistant([call("c1", "logs", {})], "toolUse", 1000),
      result("c1", "logs", "ok", false, undefined, 4000),
    ]),
    busy: false,
  },
  {
    name: "busy-empty",
    view: view([user("hi")], { run: {} }),
    busy: true,
  },
  {
    name: "orphan-result",
    view: view([
      // A result that outruns its call in the log joins once the call lands.
      result("c1", "read", "early"),
      user("go"),
      assistant([call("c1", "read", { path: "a" })], "toolUse"),
    ]),
    busy: false,
  },
  {
    name: "partial-then-committed-live",
    view: view([user("hi")], {
      run: {},
      generation: { attempt: 1, message: { role: "assistant", content: [thinking("hmm"), text("hel")] } },
    }),
    busy: true,
  },
  {
    name: "partial-then-committed-done",
    view: view([user("hi"), assistant([thinking("hmm"), text("hello")])]),
    busy: false,
  },
  {
    name: "unicode",
    // A lone surrogate mid-string (host truncation produces these) and a
    // non-BMP emoji — the wire keeps them, the UI sees U+FFFD for the loner.
    view: view([
      user("phone \ud83d and a rocket 🚀"),
      assistant([thinking("想🤔"), text("done \ud83d ok")]),
    ]),
    busy: false,
  },
  {
    name: "todo-rewritten",
    // The doc changes when the call executes, so the stamp is the result's,
    // not the issuing message's; the last write wins.
    view: view([
      user("go"),
      assistant([call("t1", "todo_write", { items: [] })], "toolUse", 50),
      result("t1", "todo_write", "Todo list updated: 0 item(s).", false, undefined, 100),
      assistant([call("c1", "bash", { command: "ls" })], "toolUse", 150),
      result("c1", "bash", "ok", false, undefined, 200),
      assistant([call("t2", "todo_write", { items: [] })], "toolUse", 250),
      result("t2", "todo_write", "Todo list updated: 0 item(s).", false, undefined, 300),
      assistant([text("done")], "stop", 350),
    ]),
    busy: false,
  },
  {
    name: "todo-pending-write",
    // A write still executing has not changed the doc yet.
    view: view(
      [
        user("go"),
        assistant([call("t1", "todo_write", { items: [] })], "toolUse", 50),
        result("t1", "todo_write", "Todo list updated: 0 item(s).", false, undefined, 100),
        assistant([call("t2", "todo_write", { items: [] })], "toolUse", 250),
      ],
      { run: {}, tools: [{ callId: "t2", name: "todo_write", status: "running" }] },
    ),
    busy: true,
  },
  {
    name: "todo-in-codemode",
    // A script's nested write counts at the outer result's time, even when the
    // script failed afterwards; a nested write that failed does not count.
    view: view([
      user("go"),
      assistant([call("t1", "todo_write", { items: [] })], "toolUse", 50),
      result("t1", "todo_write", "Todo list updated: 0 item(s).", false, undefined, 100),
      assistant([call("c1", "codemode", { code: "await tools.todo_write({ items: [] }); throw new Error()" })], "toolUse", 250),
      result("c1", "codemode", "Error", true, {
        calls: [
          { name: "bash", args: "{}", status: "ok" },
          { name: "todo_write", args: "{\"items\":[]}", status: "ok" },
        ],
      }, 300),
      assistant([call("c2", "codemode", { code: "await tools.todo_write({ items: 1 })" })], "toolUse", 450),
      result("c2", "codemode", "Error", true, {
        calls: [{ name: "todo_write", args: "{\"items\":1}", status: "error", error: "Validation failed" }],
      }, 500),
      assistant([text("done")], "stop", 550),
    ]),
    busy: false,
  },
  {
    name: "todo-failed-write",
    view: view([
      user("go"),
      assistant([call("t1", "todo_write", { items: "bad" })], "toolUse", 50),
      result("t1", "todo_write", "Validation failed", true, undefined, 100),
      assistant([text("done")], "stop", 150),
    ]),
    busy: false,
  },
  {
    name: "user-images-mixed",
    view: view([
      user([
        text("look"),
        image("aGk=", "image/png"),
        // Both forms on one block: the bytes win (ADR-0027).
        { type: "image", data: "aGk=", mimeType: "image/webp", ref: "ignored" },
        imageRef("5f2a", "image/jpeg"),
      ]),
      assistant([text("seen")]),
    ]),
    busy: false,
  },
  {
    name: "tool-result-images-mixed",
    view: view([
      user("go"),
      assistant([call("c1", "mcp__shot__capture", {})], "toolUse"),
      entry("pi.tool-result", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "mcp__shot__capture",
        content: [text("captured"), image("aGk=", "image/png"), imageRef("5f2a", "image/jpeg")],
        isError: false,
        timestamp: 0,
      }),
    ]),
    busy: false,
  },
  // Appended after the earlier cases so their entry-id counters (and the
  // committed vectors) do not shift.
  {
    // The host records when the first answer text arrived; a one-message run
    // has no later timestamp to measure to.
    name: "answer-started-single",
    view: view([
      user("go"),
      assistant([thinking("plan"), text("done")], "stop", 1000, { pinomad: { answerStartedAt: 2500 } }),
    ]),
    busy: false,
  },
  {
    name: "answer-started-multi",
    view: view([
      user("go"),
      assistant([call("c1", "logs", {})], "toolUse", 1000),
      result("c1", "logs", "ok", false, undefined, 3000),
      assistant([text("done")], "stop", 5000, { pinomad: { answerStartedAt: 6500 } }),
    ]),
    busy: false,
  },
  {
    name: "answer-started-invalid-early",
    view: view([
      user("go"),
      assistant([text("done")], "stop", 1000, { pinomad: { answerStartedAt: 500 } }),
    ]),
    busy: false,
  },
  {
    name: "answer-started-invalid-nonfinite",
    view: view([
      user("go"),
      assistant([text("done")], "stop", 1000, { pinomad: { answerStartedAt: Number.POSITIVE_INFINITY } }),
    ]),
    busy: false,
  },
  {
    name: "answer-started-fallback-multi",
    view: view([
      user("go"),
      assistant([call("c1", "logs", {})], "toolUse", 1000),
      result("c1", "logs", "ok", false, undefined, 3000),
      assistant([text("done")], "stop", 5000),
    ]),
    busy: false,
  },
  {
    // The host records when it received the prompt; the bubble dates itself
    // from the user message's own stamp.
    name: "user-timestamp",
    view: view([user("go", 1234), assistant([text("done")], "stop", 2000)]),
    busy: false,
  },
  {
    // A settled run ends when its last answer finished: request start plus
    // the response's measured duration.
    name: "run-ended-at",
    view: view([
      user("go", 1000),
      assistant([call("c1", "logs", {})], "toolUse", 1100),
      result("c1", "logs", "ok", false, undefined, 1500),
      assistant([text("done")], "stop", 2000, { durationMs: 350 }),
    ]),
    busy: false,
  },
  {
    // Older messages carry no duration: the request start is the best end.
    name: "run-ended-at-fallback",
    view: view([user("go", 1000), assistant([text("done")], "stop", 2000)]),
    busy: false,
  },
  {
    // While the run is still live the answer is not final, so it has no end.
    name: "run-ended-at-live",
    view: view([user("go", 1000), assistant([text("done")], "stop", 2000, { durationMs: 350 })], { run: {} }),
    busy: true,
  },
  {
    name: "submission-local-sending",
    view: view([user("host hello")]),
    busy: false,
    submissions: [local()],
  },
  {
    name: "submission-local-unknown",
    view: view([]),
    busy: false,
    submissions: [local({ phase: "unknown" })],
  },
  {
    name: "submission-local-failed",
    view: view([]),
    busy: false,
    submissions: [local({ phase: "failed", error: "refused" })],
  },
  {
    name: "submission-local-queue-hidden",
    view: view([user("host hello")]),
    busy: true,
    submissions: [local({ placement: "queue" })],
  },
  {
    name: "submission-local-other-conversation",
    view: view([user("host hello")]),
    busy: false,
    submissions: [local({ conversationId: 2 as never })],
  },
  {
    name: "submission-local-settled-hidden",
    view: view([user("host hello")]),
    busy: false,
    submissions: [local({ phase: "settled" })],
  },
  {
    // The allowed short duplicate: the host entry and the local row coexist
    // until the result arrives.
    name: "submission-local-duplicate",
    view: view([user("local hello")]),
    busy: false,
    submissions: [local()],
  },
];

/** Cases also exercised through `retryOf` — by name into DERIVE_CHAT_CASES. */
export const RETRY_CASES: DeriveChatCase[] = [
  { name: "retry-simple", view: view([user("go"), failed()]), busy: false },
  { name: "retry-images", view: view([user([text("look"), image("aGk=", "image/png")]), failed()]), busy: false },
  // A retry resends the picked skills too (ADR-0028), not just the typed text.
  { name: "retry-skills", view: view([user(`${block("review", "Review steps.")}\n\n$review do x`), failed()]), busy: false },
  { name: "retry-image-only", view: view([user([image("aGk=", "image/png")]), failed()]), busy: false },
  {
    name: "retry-attachments",
    view: view([user([text("look"), text(attachmentBlock([attached()]))]), failed()]),
    busy: false,
  },
  { name: "retry-empty-prompt", view: view([user(""), failed()]), busy: false },
  { name: "retry-not-newest", view: view([user("go"), failed(), user("again"), assistant([text("recovered")])]), busy: false },
  { name: "retry-succeeded", view: view([user("go"), assistant([text("done")])]), busy: false },
  {
    name: "retry-compaction",
    view: view([user("go"), entry("pi.compaction", { role: "user", content: "summary" }), failed()]),
    busy: false,
  },
  { name: "retry-reset", view: view([user("go"), entry("pi.reset"), failed()]), busy: false },
  { name: "retry-steer", view: view([user("first"), assistant([text("one")]), user("steer"), failed()]), busy: false },
  { name: "retry-second-failure", view: view([user("go"), failed(), user("go"), failed()]), busy: false },
  {
    name: "retry-images-mixed",
    view: view([user([text("look"), image("aGk=", "image/png"), imageRef("5f2a", "image/jpeg")]), failed()]),
    busy: false,
  },
];

export interface SplitCase {
  readonly name: string;
  readonly cot: CotView;
}

export const SPLIT_CASES: SplitCase[] = [
  {
    name: "split-hand",
    cot: (() => {
      const tool = (id: string, name: string) => ({ state: "output-available" as const, toolCallId: id, toolName: name });
      return {
        phase: "settled" as const,
        steps: [
          { kind: "tools" as const, id: "1-tools-0", tools: [tool("c1", "subagent"), tool("c2", "read")], live: false },
          { kind: "interim" as const, id: "1-text-1", text: "looking" },
          { kind: "tools" as const, id: "1-tools-2", tools: [tool("c3", "subagent")], live: false },
        ],
        answer: { text: "done", streaming: false },
      } as CotView;
    })(),
  },
  {
    name: "split-settles-active",
    cot: runs(
      deriveChat(
        view(
          [
            user("go"),
            assistant([call("c1", "read", { path: "a.ts" }), call("c2", "subagent", { task: "x" })], "toolUse"),
            result("c1", "read", "done"),
          ],
          { run: {}, tools: [{ callId: "c2", name: "subagent", status: "running" }] },
        ),
        {},
        true,
      ),
    )[0]!.cot,
  },
  {
    name: "split-hands-active",
    cot: runs(
      deriveChat(
        view(
          [
            user("go"),
            assistant(
              [call("c1", "read", { path: "a.ts" }), call("c2", "subagent", { task: "x" }), call("c3", "read", { path: "b.ts" })],
              "toolUse",
            ),
            result("c1", "read", "done"),
          ],
          { run: {}, tools: [{ callId: "c2", name: "subagent", status: "running" }] },
        ),
        {},
        true,
      ),
    )[0]!.cot,
  },
  {
    name: "split-dup-callid",
    cot: runs(
      deriveChat(
        view([
          user("go"),
          assistant([call("c1", "subagent", { task: "one" })], "toolUse"),
          result("c1", "subagent", "r1"),
          assistant([call("c1", "subagent", { task: "two" })], "toolUse"),
          result("c1", "subagent", "r2"),
        ]),
        {},
        false,
      ),
    )[0]!.cot,
  },
];
