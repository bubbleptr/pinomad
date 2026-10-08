import type { ConversationView, EntryRecord, TaskGraph } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { queueItems, statusText, taskRows, usageRows } from "../src/presentation/chat.ts";

const text = (value: string) => ({ type: "text", text: value });
const view = (entries: EntryRecord[], live: object = {}, inbox: object[] = []): ConversationView =>
  ({ conversation: { id: 0 }, entries, docs: { "pi.live": live, "pi.inbox": { items: inbox } } }) as unknown as ConversationView;

describe("statusText", () => {
  it("names what the conversation is doing, most specific first", () => {
    expect(statusText(view([]))).toBe("");
    expect(statusText(view([], { run: {} }))).toBe("");
    expect(statusText(view([], { run: {}, tools: [{ callId: "c", name: "logs", status: "running" }] }))).toBe("");
    expect(statusText(view([], { run: {}, generation: { attempt: 1, retry: { at: 0, error: "overloaded" } } }))).toBe(
      "Retrying (attempt 2): overloaded",
    );
    expect(statusText(view([], { compactions: [{ reason: "manual", attempt: 1 }] }))).toBe("Compacting (manual)...");
  });
});

describe("queueItems", () => {
  it("lists queued inputs with their mode", () => {
    expect(queueItems(view([], {}, [{ id: 1, mode: "steer", content: "focus" }, { id: 2, mode: "followUp", content: [text("then this")] }]))).toEqual([
      { id: 1, mode: "steer", text: "focus" },
      { id: 2, mode: "followUp", text: "then this" },
    ]);
  });
});

describe("taskRows", () => {
  it("nests owned tasks and conversation-owned tasks under their owner", () => {
    const graph = {
      tasks: {
        "1": { id: 1, kind: "pi.generation", conversationId: 0, background: false, abortRequested: false, state: { status: "waiting", phase: "tools", on: [2], policy: "all" }, conversations: [] },
        "2": { id: 2, kind: "pi.tool", conversationId: 0, owner: 1, background: false, abortRequested: false, state: { status: "running", phase: "run" }, conversations: [5] },
        "3": { id: 3, kind: "pi.generation", conversationId: 5, background: false, abortRequested: true, state: { status: "running", phase: "request" }, conversations: [] },
      },
    } as unknown as TaskGraph;
    expect(taskRows(graph)).toEqual([
      { id: 1, depth: 0, label: "pi.generation #1: waiting on 2" },
      { id: 2, depth: 1, label: "pi.tool #2: running run owns conversation 5" },
      { id: 3, depth: 2, label: "pi.generation #3: running request [aborting]" },
    ]);
  });
});

describe("usageRows", () => {
  it("sums usage per model and tool", () => {
    const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } });
    const conversation = { ...view([]), docs: { "pi.usage": { models: { "faux/faux-1": usage(120, 30, 0.002) }, tools: { search_logs: usage(0, 0, 0) } } } };
    expect(usageRows(conversation as unknown as ConversationView)).toEqual([
      { key: "faux/faux-1", input: 120, output: 30, cost: 0.002 },
      { key: "search_logs", input: 0, output: 0, cost: 0 },
    ]);
    expect(usageRows(view([]))).toEqual([]);
  });
});
