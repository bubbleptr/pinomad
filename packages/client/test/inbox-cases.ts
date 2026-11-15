// Cases for the Inbox task-state vector (ADR-0051 §2): the state each task
// reads as, and the sidebar's groups. Inputs are wire values.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { InboxEvent, InboxTask } from "@pinomad/protocol/inbox.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import type { InboxGroupName, InboxTaskState } from "../src/inbox.ts";

export const event = (id: string, receivedAt: number, handled: boolean): InboxEvent => ({
  id,
  source: "user",
  summary: `event ${id}`,
  trusted: true,
  receivedAt,
  handled,
});

export const task = (id: string, over: Partial<InboxTask> = {}): InboxTask => ({
  id,
  title: `task ${id}`,
  createdAt: 1,
  events: [event(`${id}-1`, 10, true)],
  closed: false,
  ...over,
});

const conversation = 7 as ConversationId;
const summary = (status?: ConversationSummary["status"]): ConversationSummary => ({
  id: conversation,
  kind: "conversation",
  title: "t",
  ...(status === undefined ? {} : { status }),
});

export const INBOX_STATE_CASES: { name: string; task: InboxTask; summary?: ConversationSummary; expect: InboxTaskState }[] = [
  { name: "unhandled events and no run are pending", task: task("a", { events: [event("e", 10, false)] }), expect: "pending" },
  { name: "a batch in flight is running", task: task("a", { inFlight: true, conversationId: conversation }), expect: "running" },
  {
    name: "a running conversation is running",
    task: task("a", { conversationId: conversation }),
    summary: summary("running"),
    expect: "running",
  },
  {
    name: "new events while its conversation runs stay running",
    task: task("a", { conversationId: conversation, events: [event("e1", 10, true), event("e2", 20, false)] }),
    summary: summary("running"),
    expect: "running",
  },
  { name: "a parked task is waiting", task: task("a", { inFlight: true, waiting: true, conversationId: conversation }), expect: "waiting" },
  {
    name: "a question in its conversation is waiting",
    task: task("a", { inFlight: true, conversationId: conversation }),
    summary: summary("needs-answer"),
    expect: "waiting",
  },
  {
    name: "an answered task whose run resumed is running before the worker clears waiting",
    task: task("a", { inFlight: true, waiting: true, conversationId: conversation }),
    summary: summary("running"),
    expect: "running",
  },
  { name: "closed is done", task: task("a", { closed: true, conversationId: conversation }), expect: "done" },
  {
    name: "a failed run on a closed task is still done",
    task: task("a", { closed: true, conversationId: conversation }),
    summary: summary("failed"),
    expect: "done",
  },
  { name: "skipped", task: task("a", { closed: true, skipped: true }), expect: "skipped" },
  { name: "the worker gave up", task: task("a", { closed: true, failed: "boom" }), expect: "failed" },
  {
    name: "a reopened task is pending again",
    task: task("a", { conversationId: conversation, events: [event("e1", 10, true), event("e2", 20, false)] }),
    summary: summary(),
    expect: "pending",
  },
  { name: "open with nothing left to send reads as done", task: task("a"), expect: "done" },
];

export const INBOX_GROUP_CASES: {
  name: string;
  tasks: InboxTask[];
  summaries: ConversationSummary[];
  expect: [InboxGroupName, string[]][];
}[] = [
  { name: "empty", tasks: [], summaries: [], expect: [["waiting", []], ["running", []], ["pending", []], ["done", []]] },
  {
    name: "sidebar order: waiting, running, pending, done",
    tasks: [
      task("done-old", { closed: true, events: [event("d1", 10, true)] }),
      task("pending-late", { events: [event("p1", 50, false)] }),
      task("skipped", { closed: true, skipped: true, events: [event("s1", 40, true)] }),
      task("waiting", { inFlight: true, waiting: true, events: [event("w1", 5, true)] }),
      task("pending-early", { events: [event("p2", 20, true), event("p3", 30, false)] }),
      task("running", { inFlight: true, events: [event("r1", 15, true)] }),
      task("failed", { closed: true, failed: "boom", events: [event("f1", 60, true)] }),
      task("by-summary", { conversationId: conversation, events: [event("b1", 70, true)] }),
    ],
    summaries: [summary("running")],
    expect: [
      ["waiting", ["waiting"]],
      // Newest activity first.
      ["running", ["by-summary", "running"]],
      // The worker's order: the longest-waiting event first.
      ["pending", ["pending-early", "pending-late"]],
      // Skipped and failed close too; newest first.
      ["done", ["failed", "skipped", "done-old"]],
    ],
  },
];
