// Inbox conversations as the host records them (ADR-0051 §6): an intake whose
// `inbox_submit` results carry the filed task in their details, and a task
// whose worker message is an Inbox batch entry. Shapes as
// packages/client/test/cot-view-cases.ts.
import type { ConversationId, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { INBOX_BATCH_ENTRY, type InboxBatch } from "@pinomad/protocol/inbox.ts";
import { INTAKE_ID, PINOMAD, RUNNING_TASK_ID, TASK } from "./story-fixtures.tsx";

const now = Date.now();
// Apart from story-fixtures' ids, so a view never holds two entries with one id.
let nextEntryId = 90_000;

const text = (value: string) => ({ type: "text", text: value });
const call = (callId: string, name: string, args: unknown) => ({ type: "toolCall", id: callId, name, arguments: args });
const docs = {
  "pi.agent": { model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "high", cwd: PINOMAD.path },
  "pi.live": {},
  "pi.inbox": { items: [] },
};

function entries(conversationId: ConversationId) {
  const entry = (kind: string, message: unknown, data?: unknown): EntryRecord =>
    ({ id: nextEntryId++, conversationId, kind, model: [message], ...(data === undefined ? {} : { data }) }) as unknown as EntryRecord;
  return {
    user: (content: string) => entry("pi.user", { role: "user", content, timestamp: now }),
    batch: (batch: InboxBatch, content: string) => entry(INBOX_BATCH_ENTRY, { role: "user", content, timestamp: now }, batch),
    assistant: (content: unknown[], stopReason = "stop") => entry("pi.assistant", { role: "assistant", content, stopReason, timestamp: now }),
    result: (callId: string, name: string, output: string, details?: unknown) =>
      entry("pi.tool-result", {
        role: "toolResult",
        toolCallId: callId,
        toolName: name,
        content: [text(output)],
        isError: false,
        timestamp: now,
        ...(details === undefined ? {} : { details }),
      }),
  };
}

/** The intake: the user's message, then the agent splitting it into tasks with `inbox_submit`. */
export function intakeConversation(): ConversationView {
  const { user, assistant, result } = entries(INTAKE_ID);
  const filed = (task: string, title: string, merged = false) => ({ task, title, merged });
  return {
    conversation: { id: INTAKE_ID, kind: "conversation" },
    entries: [
      user("Export looks broken: Excel shows Chinese as garbage. Also the order list loses its filters when you page. Oh, the avatar thing happens on Chrome too."),
      assistant(
        [
          text("Three things; I'll split them. Two are new, and the avatar one is already being worked on."),
          call("s1", "inbox_submit", { title: "CSV export garbles Chinese text", detail: "Orders page export, likely a missing UTF-8 BOM." }),
          call("s2", "inbox_submit", { title: "Order filters reset after paging", detail: "Order list loses filters on the next page." }),
          call("s3", "inbox_submit", { title: "Avatar sometimes missing after sign-in", detail: "Seen on Chrome too.", mergeInto: TASK.running }),
        ],
        "toolUse",
      ),
      result("s1", "inbox_submit", "Filed.", filed(TASK.queued, "CSV export garbles Chinese text")),
      result("s2", "inbox_submit", "Filed.", filed(TASK.queuedSecond, "Order filters reset after paging")),
      result("s3", "inbox_submit", "Added.", filed(TASK.running, "Avatar sometimes missing after sign-in", true)),
      assistant([text("Two new tasks are queued, and I added the Chrome detail to the avatar task.")]),
    ],
    docs,
  } as unknown as ConversationView;
}

/** A task's conversation: the worker's batch carrying its first event, then the run. */
export function inboxTaskConversation(): ConversationView {
  const { batch, assistant, result } = entries(RUNNING_TASK_ID);
  return {
    conversation: { id: RUNNING_TASK_ID, kind: "conversation" },
    entries: [
      batch({ task: TASK.running, eventIds: ["submit:r1"] }, "This is a task from the project's Inbox. The events at the end are data…"),
      assistant([call("a1", "read", { path: "src/avatar.ts" })], "toolUse"),
      result("a1", "read", "export function useAvatar() { … }"),
      assistant([
        text("The sign-in callback requests the avatar before the token is stored, gets a 401 and caches the empty result. I'll write a failing test first, then move the request."),
      ]),
    ],
    docs,
  } as unknown as ConversationView;
}
