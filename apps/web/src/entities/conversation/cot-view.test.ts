// The Durable→CotView adapter: same fixture style as apps/web/test/presentation.test.ts.
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { deriveChat, pinomadOf, splitSubagentCalls, type ChatEntry, type CotView } from "./cot-view.ts";

let nextId = 1;
const entry = (kind: string, message?: unknown): EntryRecord =>
  ({ id: nextId++, conversationId: 0, kind, ...(message === undefined ? {} : { model: [message] }) }) as unknown as EntryRecord;
const user = (text: string) => entry("pi.user", { role: "user", content: text, timestamp: 0 });
const assistant = (content: unknown[], stopReason = "stop", timestamp = 0, extra: object = {}) =>
  entry("pi.assistant", { role: "assistant", content, stopReason, timestamp, ...extra });
const result = (callId: string, name: string, output: string, isError = false, details?: unknown, timestamp = 0) =>
  entry("pi.tool-result", {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text: output }],
    isError,
    timestamp,
    ...(details === undefined ? {} : { details }),
  });
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const image = (data: string, mimeType: string) => ({ type: "image", data, mimeType });
const view = (entries: EntryRecord[], live: object = {}): ConversationView =>
  ({ conversation: { id: 0 }, entries, docs: { "pi.live": live } }) as unknown as ConversationView;
const runs = (entries: ChatEntry[]) => entries.filter((item) => item.kind === "run");

describe("deriveChat", () => {
  it("groups consecutive calls into one tools step, mid-run text into interim, final text into the answer", () => {
    const entries = deriveChat(
      view([
        user("go"),
        assistant([thinking("plan"), call("c1", "read", { path: "a.ts" }), call("c2", "read", { path: "b.ts" })], "toolUse"),
        result("c1", "read", "A"),
        result("c2", "read", "B"),
        assistant([text("checking next"), call("c3", "bash", { command: "ls" })], "toolUse"),
        result("c3", "bash", "ok"),
        assistant([text("done")]),
      ]),
      {},
      false,
    );
    expect(entries[0]).toMatchObject({ kind: "user", text: "go" });
    const run = runs(entries)[0]!;
    expect(run.cot.phase).toBe("settled");
    expect(run.cot.steps.map((step) => step.kind)).toEqual(["thinking", "tools", "interim", "tools"]);
    const burst = run.cot.steps[1] as Extract<(typeof run.cot.steps)[number], { kind: "tools" }>;
    expect(burst.tools.map((tool) => [tool.toolCallId, tool.state, tool.output])).toEqual([
      ["c1", "output-available", "A"],
      ["c2", "output-available", "B"],
    ]);
    expect(run.cot.steps[2]).toMatchObject({ kind: "interim", text: "checking next" });
    expect(run.cot.answer).toEqual({ text: "done", streaming: false });
    expect(run.interrupted).toBe(false);
    expect(run.forkEntryId).toBeDefined();
  });

  it("phases a live run: thinking on a thinking-only partial, acting with the active call, answering on partial text, settled when idle", () => {
    const thinkingOnly = deriveChat(
      view([user("hi")], { run: {}, generation: { attempt: 1, message: { role: "assistant", content: [thinking("che")] } } }),
      {},
      true,
    );
    const thinkingRun = runs(thinkingOnly)[0]!;
    expect(thinkingRun.cot.phase).toBe("thinking");
    expect(thinkingRun.cot.steps[0]).toMatchObject({ kind: "thinking", text: "che", live: true });

    const acting = deriveChat(
      view(
        [user("go"), assistant([call("c1", "logs", {})], "toolUse")],
        { run: {}, tools: [{ callId: "c1", name: "logs", status: "running" }] },
      ),
      {},
      true,
    );
    const actingRun = runs(acting)[0]!;
    expect(actingRun.cot.phase).toBe("acting");
    const actingStep = actingRun.cot.steps[0] as Extract<(typeof actingRun.cot.steps)[number], { kind: "tools" }>;
    expect(actingStep.live).toBe(true);
    expect(actingStep.activeToolCallId).toBe("c1");
    expect(actingStep.tools[0]).toMatchObject({ state: "input-available" });

    const answering = deriveChat(
      view([user("hi")], { run: {}, generation: { attempt: 1, message: { role: "assistant", content: [text("hel")] } } }),
      {},
      true,
    );
    const answeringRun = runs(answering)[0]!;
    expect(answeringRun.cot.phase).toBe("answering");
    expect(answeringRun.cot.answer).toEqual({ text: "hel", streaming: true });

    const settled = deriveChat(view([user("hi"), assistant([text("hello")])]), {}, false);
    expect(runs(settled)[0]!.cot.phase).toBe("settled");
  });

  it("a tool call streaming in the partial is input-streaming", () => {
    const entries = deriveChat(
      view([user("go")], {
        run: {},
        generation: { attempt: 1, message: { role: "assistant", content: [call("c1", "read", { path: "a" })] } },
      }),
      {},
      true,
    );
    const step = runs(entries)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    expect(step.tools[0]).toMatchObject({ toolCallId: "c1", toolName: "read", state: "input-streaming" });
  });

  it("an interrupted answer errors its unrun calls, marks the run interrupted, and blocks forking", () => {
    const entries = deriveChat(
      view([user("go"), assistant([call("c1", "logs", {})], "aborted")]),
      {},
      false,
    );
    const run = runs(entries)[0]!;
    const step = run.cot.steps[0] as Extract<(typeof run.cot.steps)[number], { kind: "tools" }>;
    expect(step.tools[0]).toMatchObject({ state: "output-error", output: "Not run: the answer was interrupted." });
    expect(run.interrupted).toBe(true);
    expect(run.forkEntryId).toBeUndefined();
  });

  it("a failed run carries the error message and no fork", () => {
    const entries = deriveChat(
      view([user("go"), assistant([text("")], "error", 0, { errorMessage: "HTTP 429 quota exceeded" })]),
      {},
      false,
    );
    const run = runs(entries)[0]!;
    expect(run.failure).toBe("HTTP 429 quota exceeded");
    expect(run.cot.outcome).toBe("failed");
    expect(run.forkEntryId).toBeUndefined();
  });

  it("an edit result with pinomad.diff details carries the diff payload and line stats", () => {
    const patch = "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n";
    const entries = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "edit", { path: "a.ts" })], "toolUse"),
        result("c1", "edit", "edited a.ts", false, { patch }),
      ]),
      { edit: "pinomad.diff" },
      false,
    );
    const step = runs(entries)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    expect(pinomadOf(step.tools[0]!)).toEqual({ kind: "diff", patch });
    expect(step.tools[0]!.diffStat).toEqual({ additions: 1, deletions: 1 });

    const nonConforming = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "edit", { path: "a.ts" })], "toolUse"),
        result("c1", "edit", "edited", false, { notAPatch: true }),
      ]),
      { edit: "pinomad.diff" },
      false,
    );
    const plainStep = runs(nonConforming)[0]!.cot.steps[0] as typeof step;
    expect(pinomadOf(plainStep.tools[0]!)).toBeUndefined();
    expect(plainStep.tools[0]!.diffStat).toBeUndefined();
  });

  it("maps codemode nested calls, with a still-running call cancelled once the card settled", () => {
    const details = {
      code: "await tools.bash({})",
      calls: [
        { name: "bash", args: "{}", status: "ok", durationMs: 10 },
        { name: "read", args: "{}", status: "running" },
        { name: "edit", args: "{}", status: "error", error: "conflict" },
      ],
    };
    const entries = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "codemode", { code: details.code })], "toolUse"),
        result("c1", "codemode", "script result", false, details),
      ]),
      { codemode: "pinomad.codemode" },
      false,
    );
    const step = runs(entries)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    const parent = step.tools[0]!;
    expect(parent.argsText).toBe(details.code);
    expect(parent.output).toBe("script result");
    expect(parent.children!.map((child) => [child.toolName, child.state, child.output])).toEqual([
      ["bash", "output-available", undefined],
      ["read", "output-error", "Cancelled"],
      ["edit", "output-error", "conflict"],
    ]);
    expect(parent.children![0]!.durationMs).toBe(10);
  });

  it("keeps a codemode nested call running while its card runs, and carries a nested diff", () => {
    const details = {
      code: "x",
      calls: [
        { name: "read", args: "{}", status: "running" },
        { name: "edit", args: "{}", status: "ok", details: { patch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" } },
      ],
    };
    const entries = deriveChat(
      view([user("go"), assistant([call("c1", "codemode", { code: "x" })], "toolUse")], {
        run: {},
        tools: [{ callId: "c1", name: "codemode", status: "running", details }],
      }),
      { codemode: "pinomad.codemode", edit: "pinomad.diff" },
      true,
    );
    const step = runs(entries)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    const children = step.tools[0]!.children!;
    expect(children[0]).toMatchObject({ toolName: "read", state: "input-available" });
    expect(pinomadOf(children[1]!)).toMatchObject({ kind: "diff" });
  });

  it("links a subagent call to its child conversation from a live slot and from the result", () => {
    const live = deriveChat(
      view([user("go"), assistant([call("c1", "subagent", { task: "survey" })], "toolUse")], {
        run: {},
        tools: [{ callId: "c1", name: "subagent", status: "running", details: { conversationId: 7, model: "faux/faux-1", startedAt: 1000 } }],
      }),
      {},
      true,
    );
    const liveStep = runs(live)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    expect(pinomadOf(liveStep.tools[0]!)).toEqual({ kind: "subagent", conversationId: 7, model: "faux/faux-1", startedAt: 1000 });

    const done = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "subagent", { task: "survey" })], "toolUse"),
        result("c1", "subagent", "report", false, { conversationId: 9, model: "faux/faux-1", startedAt: 1000 }, 4000),
      ]),
      {},
      false,
    );
    const doneStep = runs(done)[0]!.cot.steps[0] as typeof liveStep;
    expect(pinomadOf(doneStep.tools[0]!)).toEqual({
      kind: "subagent",
      conversationId: 9,
      output: "report",
      model: "faux/faux-1",
      startedAt: 1000,
      endedAt: 4000,
    });
  });

  it("collects result images onto the tool item", () => {
    const withImage = entry("pi.tool-result", {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "mcp__shot__capture",
      content: [text("captured"), image("aGk=", "image/png")],
      isError: false,
      timestamp: 0,
    });
    const entries = deriveChat(view([user("go"), assistant([call("c1", "mcp__shot__capture", {})], "toolUse"), withImage]), {}, false);
    const step = runs(entries)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    expect(step.tools[0]!.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });

  it("lifts subagent calls out of tools steps, keeping order and dropping emptied steps", () => {
    const tool = (id: string, name: string) => ({ toolCallId: id, toolName: name, state: "output-available" as const });
    const cot = {
      phase: "settled" as const,
      steps: [
        { kind: "tools" as const, tools: [tool("c1", "subagent"), tool("c2", "read")] },
        { kind: "interim" as const, text: "looking" },
        { kind: "tools" as const, tools: [tool("c3", "subagent")] },
      ],
      answer: { text: "done", streaming: false },
    } as CotView;
    const { view: next, subagents } = splitSubagentCalls(cot);
    expect(subagents.map((item) => item.tool.toolCallId)).toEqual(["c1", "c3"]);
    expect(next.steps.map((step) => step.kind)).toEqual(["tools", "interim"]);
    const kept = next.steps[0] as Extract<CotView["steps"][number], { kind: "tools" }>;
    expect(kept.tools.map((item) => item.toolCallId)).toEqual(["c2"]);
  });

  it("settles the surviving tools step when the lifted call was the active one", () => {
    // Live run: read already answered, the subagent is the in-flight call.
    const cot = runs(
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
    )[0]!.cot;
    const before = cot.steps[0] as Extract<CotView["steps"][number], { kind: "tools" }>;
    expect(before.live).toBe(true);
    expect(before.activeToolCallId).toBe("c2");

    const { view: next } = splitSubagentCalls(cot);
    const step = next.steps[0] as Extract<CotView["steps"][number], { kind: "tools" }>;
    expect(step.tools.map((item) => item.toolCallId)).toEqual(["c1"]);
    // Nothing is still in flight: the row must not keep showing a stale call.
    expect(step.live).toBe(false);
    expect(step.activeToolCallId).toBeUndefined();
  });

  it("hands the active slot to a still-pending call when the active one was lifted", () => {
    const cot = runs(
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
    )[0]!.cot;

    const { view: next } = splitSubagentCalls(cot);
    const step = next.steps[0] as Extract<CotView["steps"][number], { kind: "tools" }>;
    expect(step.tools.map((item) => item.toolCallId)).toEqual(["c1", "c3"]);
    // c3 is queued but unstarted: it becomes the step's active call.
    expect(step.live).toBe(true);
    expect(step.activeToolCallId).toBe("c3");
  });

  it("keys lifted subagent calls by their step so a reused call id stays distinct", () => {
    const cot = runs(
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
    )[0]!.cot;
    const { subagents } = splitSubagentCalls(cot);
    expect(subagents).toHaveLength(2);
    expect(subagents[0]!.tool.toolCallId).toBe("c1");
    expect(subagents[1]!.tool.toolCallId).toBe("c1");
    expect(subagents[0]!.key).not.toBe(subagents[1]!.key);
  });

  it("splits runs at compaction and reset boundaries", () => {
    const entries = deriveChat(
      view([
        user("one"),
        assistant([text("first")]),
        entry("pi.compaction", { role: "user", content: "summary" }),
        entry("pi.reset"),
        user("two"),
        assistant([text("second")]),
      ]),
      {},
      false,
    );
    expect(entries.map((item) => item.kind)).toEqual(["user", "run", "compaction", "reset", "user", "run"]);
    expect(runs(entries)[0]!.cot.answer?.text).toBe("first");
    expect(runs(entries)[1]!.cot.answer?.text).toBe("second");
  });

  it("anchors the run clock at its first assistant message and measures to the answer", () => {
    const entries = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "logs", {})], "toolUse", 1000),
        result("c1", "logs", "ok", false, undefined, 3000),
        assistant([text("done")], "stop", 5000),
      ]),
      {},
      false,
    );
    const run = runs(entries)[0]!;
    expect(run.cot.anchorMs).toBe(1000);
    expect(run.cot.elapsedMs).toBe(4000);
  });

  it("matches a repeated call id to its own round's result", () => {
    const entries = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "read", { path: "a" })], "toolUse"),
        result("c1", "read", "A"),
        assistant([call("c1", "read", { path: "b" })], "toolUse"),
        result("c1", "read", "B"),
        assistant([text("done")]),
      ]),
      {},
      false,
    );
    const steps = runs(entries)[0]!.cot.steps.filter((step) => step.kind === "tools");
    expect(steps.map((step) => step.tools[0]!.output)).toEqual(["A", "B"]);
  });

  it("does not let an earlier round's result satisfy a repeated call id", () => {
    const entries = deriveChat(
      view(
        [
          user("go"),
          assistant([call("c1", "read", { path: "a" })], "toolUse"),
          result("c1", "read", "A"),
          assistant([call("c1", "read", { path: "b" })], "toolUse"),
        ],
        { run: {}, tools: [{ callId: "c1", name: "read", status: "running" }] },
      ),
      {},
      true,
    );
    const run = runs(entries)[0]!;
    expect(run.cot.phase).toBe("acting");
    const steps = run.cot.steps.filter((step) => step.kind === "tools");
    expect(steps[0]!.tools[0]).toMatchObject({ state: "output-available", output: "A" });
    expect(steps[1]!.live).toBe(true);
    expect(steps[1]!.activeToolCallId).toBe("c1");
    expect(steps[1]!.tools[0]!.state).not.toBe("output-available");
  });

  it("an aborted call is not pending: its step stays settled while the retry thinks", () => {
    const entries = deriveChat(
      view([user("go"), assistant([call("c1", "bash", { command: "x" })], "aborted")], {
        run: {},
        generation: { attempt: 1, message: { role: "assistant", content: [thinking("retrying")] } },
      }),
      {},
      true,
    );
    const step = runs(entries)[0]!.cot.steps[0] as Extract<ChatEntry, { kind: "run" }>["cot"]["steps"][number] & { kind: "tools" };
    expect(step.live).toBe(false);
    expect(step.activeToolCallId).toBeUndefined();
    expect(step.tools[0]).toMatchObject({ state: "output-error" });
  });

  it("text ahead of a running call stays interim while the answer waits", () => {
    const entries = deriveChat(
      view([user("go"), assistant([text("Checking the logs"), call("c1", "bash", { command: "ls" })], "toolUse")], {
        run: {},
        tools: [{ callId: "c1", name: "bash", status: "running" }],
      }),
      {},
      true,
    );
    const run = runs(entries)[0]!;
    expect(run.cot.answer).toBeUndefined();
    expect(run.cot.steps.map((step) => step.kind)).toEqual(["interim", "tools"]);
    expect(run.cot.steps[0]).toMatchObject({ kind: "interim", text: "Checking the logs" });
  });

  it("measures a run with no answer to its last entry", () => {
    const entries = deriveChat(
      view([
        user("go"),
        assistant([call("c1", "logs", {})], "toolUse", 1000),
        result("c1", "logs", "ok", false, undefined, 4000),
      ]),
      {},
      false,
    );
    const run = runs(entries)[0]!;
    expect(run.cot.anchorMs).toBe(1000);
    expect(run.cot.elapsedMs).toBe(3000);
  });
});
