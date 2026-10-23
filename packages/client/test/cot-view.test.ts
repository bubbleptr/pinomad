import { describe, expect, it } from "vitest";
import { deriveChat, pinomadOf, retryOf, splitSubagentCalls } from "../src/cot-view.ts";
import { DERIVE_CHAT_CASES, RETRY_CASES, SPLIT_CASES, runs } from "./cot-view-cases.ts";

const CASE = (name: string) => {
  const found = [...DERIVE_CHAT_CASES, ...RETRY_CASES].find((c) => c.name === name);
  if (!found) throw new Error(`missing case ${name}`);
  return found;
};
const derive = (name: string) => {
  const c = CASE(name);
  return deriveChat(c.view, c.presentations ?? {}, c.busy);
};

describe("deriveChat todo stamp", () => {
  it("stamps the run with its last todo_write's result time", () => {
    expect(runs(derive("todo-rewritten"))[0]!.cot.todoWrittenAtMs).toBe(300);
  });

  it("ignores a write that has not executed yet", () => {
    expect(runs(derive("todo-pending-write"))[0]!.cot.todoWrittenAtMs).toBe(100);
  });

  it("counts a codemode script's nested write at the script's result time", () => {
    expect(runs(derive("todo-in-codemode"))[0]!.cot.todoWrittenAtMs).toBe(300);
  });

  it("ignores a failed write and runs that never wrote", () => {
    expect(runs(derive("todo-failed-write"))[0]!.cot.todoWrittenAtMs).toBeUndefined();
    expect(runs(derive("settled-run"))[0]!.cot.todoWrittenAtMs).toBeUndefined();
  });
});

describe("deriveChat", () => {
  it("shows a user message without the skill blocks the host prepended", () => {
    const users = derive("user-skill-blocks").filter((item) => item.kind === "user");
    expect(users.map((item) => item.text)).toEqual(["$review do x", "look $review"]);
    // The names the host expanded: a bubble highlights `$name` only for these.
    expect(users.map((item) => item.skills)).toEqual([["review"], ["review"]]);
    expect(users[1]!.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });

  it("groups consecutive calls, thinking, interim text and answer into a run", () => {
    const entries = derive("settled-run");
    const kinds = entries.map((item) => item.kind);
    const run = entries.find((item) => item.kind === "run")!;
    expect(kinds).toEqual(["user", "run"]);
    expect(run.cot.phase).toBe("settled");
    expect(run.cot.steps.map((step) => step.kind)).toEqual(["thinking", "tools", "interim", "tools"]);
    expect(run.cot.answer?.text).toBe("done");
    expect(run.cot.answer?.streaming).toBe(false);
    // The fork anchor is the last assistant entry's id.
    expect(run.forkEntryId).toBe(String(CASE("settled-run").view.entries.at(-1)!.id));
  });

  it("phases a live run through thinking, acting and answering", () => {
    const thinkingRun = runs(derive("live-thinking")).at(-1)!;
    expect(thinkingRun.cot.phase).toBe("thinking");

    const actingRun = runs(derive("live-acting")).at(-1)!;
    expect(actingRun.cot.phase).toBe("acting");
    // The step id keys off the assistant entry's id.
    const actingAssistantId = String(CASE("live-acting").view.entries.at(-1)!.id);
    expect(actingRun.cot.steps).toEqual([
      {
        kind: "tools",
        id: `${actingAssistantId}-tools-0`,
        tools: [{ state: "input-available", toolCallId: "c1", toolName: "logs", argsText: "{}" }],
        live: true,
        activeToolCallId: "c1",
      },
    ]);

    const answeringRun = runs(derive("live-answering")).at(-1)!;
    expect(answeringRun.cot.phase).toBe("answering");
    expect(answeringRun.cot.answer).toEqual({ text: "hel", streaming: true });

    const settledRun = runs(derive("settled-simple")).at(-1)!;
    expect(settledRun.cot.phase).toBe("settled");
    expect(settledRun.cot.answer?.text).toBe("hello");
    expect(settledRun.cot.steps).toEqual([]);
  });

  it("marks a tool call streaming in the partial as input-streaming", () => {
    const run = runs(derive("live-streaming-call")).at(-1)!;
    const step = run.cot.steps.at(-1)!;
    expect(step.kind).toBe("tools");
    if (step.kind !== "tools") return;
    expect(step.tools[0]!.state).toBe("input-streaming");
    expect(run.cot.phase).toBe("acting");
  });

  it("marks an interrupted answer's pending tool calls as not run", () => {
    const run = runs(derive("interrupted")).at(-1)!;
    expect(run.interrupted).toBe(true);
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(step.tools[0]).toEqual({ state: "output-error", toolCallId: "c1", toolName: "logs", argsText: "{}", output: "Not run: the answer was interrupted." });
    expect(run.forkEntryId).toBeUndefined();
  });

  it("carries the failure on a failed run and clears forkEntryId", () => {
    const run = runs(derive("failed")).at(-1)!;
    expect(run.failure).toBe("HTTP 429 quota exceeded");
    expect(run.forkEntryId).toBeUndefined();
    expect(run.cot.outcome).toBe("failed");
  });

  it("emits pinomad.diff detail when the edit presentation declares it", () => {
    const run = runs(derive("diff")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(pinomadOf(step.tools[0]!)).toEqual({ kind: "diff", patch: "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n" });

    const run2 = runs(derive("diff-nonconforming")).at(-1)!;
    const step2 = run2.cot.steps.find((s) => s.kind === "tools")!;
    if (step2.kind !== "tools") return;
    expect(pinomadOf(step2.tools[0]!)).toBeUndefined();
  });

  it("maps a codemode call's nested calls to tool items", () => {
    const run = runs(derive("codemode")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    const codemode = step.tools[0]!;
    expect(codemode.toolName).toBe("codemode");
    expect(codemode.argsText).toBe("await tools.bash({})");
    expect(codemode.children?.map((child) => [child.toolName, child.state, child.output])).toEqual([
      ["bash", "output-available", undefined],
      ["read", "output-error", "Cancelled"],
      ["edit", "output-error", "conflict"],
    ]);
  });

  it("shows a running codemode call's nested tools live", () => {
    const run = runs(derive("codemode-live")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    const codemode = step.tools[0]!;
    expect(codemode.children?.map((child) => [child.toolCallId, child.toolName, child.state, child.output])).toEqual([
      ["c1/1", "read", "input-available", undefined],
      ["c1/2", "bash", "output-error", "Command exited with code 3"],
    ]);
    expect(codemode.children?.[1]?.durationMs).toBe(5);
  });

  it("maps legacy stored codemode calls: running shows cancelled, details carry diff patches", () => {
    const run = runs(derive("codemode-legacy")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    const children = step.tools[0]!.children!;
    expect(children[0]).toMatchObject({ toolName: "read", state: "output-error", output: "Cancelled" });
    expect(children[1]).toMatchObject({ toolName: "edit", state: "output-available" });
    expect(pinomadOf(children[1]!)).toEqual({ kind: "diff", patch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" });
  });

  it("links a subagent call to its conversation while running and once done", () => {
    const runningRun = runs(derive("subagent-live")).at(-1)!;
    const step = runningRun.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(pinomadOf(step.tools[0]!)).toEqual({ kind: "subagent", conversationId: 7, model: "faux/faux-1", startedAt: 1000 });

    const settledRun = runs(derive("subagent-done")).at(-1)!;
    const step2 = settledRun.cot.steps.find((s) => s.kind === "tools")!;
    if (step2.kind !== "tools") return;
    expect(pinomadOf(step2.tools[0]!)).toEqual({ kind: "subagent", conversationId: 9, model: "faux/faux-1", output: "report", startedAt: 1000, endedAt: 4000 });
  });

  it("collects result images onto the tool item", () => {
    const run = runs(derive("tool-result-images")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(step.tools[0]!.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });

  it("collects message images onto the user entry", () => {
    const entries = derive("user-images");
    const users = entries.filter((item) => item.kind === "user");
    expect(users[0]).toMatchObject({ text: "look", images: [{ data: "aGk=", mimeType: "image/png" }] });
    expect(users[1]).toMatchObject({ text: "", images: [{ data: "aGk=", mimeType: "image/png" }] });
  });

  it("collects ref images and prefers bytes when a block carries both", () => {
    const run = runs(derive("tool-result-images-mixed")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(step.tools[0]!.images).toEqual([
      { data: "aGk=", mimeType: "image/png" },
      { ref: "5f2a", mimeType: "image/jpeg" },
    ]);

    const user = derive("user-images-mixed").find((item) => item.kind === "user")!;
    expect(user).toMatchObject({
      images: [
        { data: "aGk=", mimeType: "image/png" },
        { data: "aGk=", mimeType: "image/webp" },
        { ref: "5f2a", mimeType: "image/jpeg" },
      ],
    });
  });

  it("splits runs at compaction and reset entries", () => {
    const entries = derive("boundaries");
    expect(entries.map((item) => item.kind)).toEqual(["user", "run", "compaction", "reset", "user", "run"]);
  });

  it("anchors the run clock at its first assistant and measures to the answer", () => {
    const run = runs(derive("anchor")).at(-1)!;
    expect(run.cot.anchorMs).toBe(1000);
    expect(run.cot.elapsedMs).toBe(4000);
  });

  it("routes a repeated call id to the newest call awaiting it", () => {
    const run = runs(derive("dup-call-id")).at(-1)!;
    const tools = run.cot.steps.flatMap((step) => (step.kind === "tools" ? step.tools : []));
    expect(tools.map((tool) => [tool.argsText, tool.state])).toEqual([
      ['{"path":"a"}', "output-available"],
      ['{"path":"b"}', "output-available"],
    ]);
  });

  it("does not let an earlier round's result satisfy the newest repeated call id", () => {
    const run = runs(derive("dup-call-id-live")).at(-1)!;
    const steps = run.cot.steps.filter((s) => s.kind === "tools");
    const first = steps[0]!;
    const second = steps[1]!;
    if (first.kind !== "tools" || second.kind !== "tools") return;
    expect(first.tools[0]!.state).toBe("output-available");
    expect(second.tools[0]!.state).toBe("input-available");
    expect(second.activeToolCallId).toBe("c1");
  });

  it("does not treat an aborted call as pending while a new run starts", () => {
    const run = runs(derive("aborted-not-pending")).at(-1)!;
    const step = run.cot.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(step.tools[0]!.state).toBe("output-error");
    expect(step.tools[0]!.output).toBe("Not run: the answer was interrupted.");
  });

  it("keeps text ahead of a running call as interim, not the answer", () => {
    const run = runs(derive("interim-before-tools")).at(-1)!;
    expect(run.cot.phase).toBe("acting");
    expect(run.cot.answer).toBeUndefined();
    expect(run.cot.steps.map((s) => s.kind)).toEqual(["interim", "tools"]);
  });

  it("measures a run with no answer through its last activity", () => {
    const run = runs(derive("elapsed-no-answer")).at(-1)!;
    expect(run.cot.elapsedMs).toBe(3000);
  });
});

describe("retryOf", () => {
  it("returns the user message a failed run answered", () => {
    expect(retryOf(derive("retry-simple"))).toEqual({ text: "go", images: [], skills: [], requestId: `retry:${runs(derive("retry-simple")).at(-1)!.id}` });
  });

  it("reuses the user's images", () => {
    expect(retryOf(derive("retry-images"))).toEqual({ text: "look", images: [{ data: "aGk=", mimeType: "image/png" }], skills: [], requestId: expect.any(String) });
  });

  it("reuses ref images as refs", () => {
    expect(retryOf(derive("retry-images-mixed"))).toEqual({
      text: "look",
      images: [
        { data: "aGk=", mimeType: "image/png" },
        { ref: "5f2a", mimeType: "image/jpeg" },
      ],
      skills: [],
      requestId: expect.any(String),
    });
  });

  it("resends the picked skills with the typed text", () => {
    expect(retryOf(derive("retry-skills"))).toEqual({ text: "$review do x", images: [], skills: ["review"], requestId: expect.any(String) });
  });

  it("treats an image-only prompt as retryable", () => {
    expect(retryOf(derive("retry-image-only"))).toEqual({ text: "", images: [{ data: "aGk=", mimeType: "image/png" }], skills: [], requestId: expect.any(String) });
  });

  it("returns undefined for an empty prompt with no images", () => {
    expect(retryOf(derive("retry-empty-prompt"))).toBeUndefined();
  });

  it("returns undefined when the failed run is not the newest entry", () => {
    expect(retryOf(derive("retry-not-newest"))).toBeUndefined();
  });

  it("returns undefined when the newest run succeeded", () => {
    expect(retryOf(derive("retry-succeeded"))).toBeUndefined();
  });

  it("walks back over a compaction to the prompt", () => {
    expect(retryOf(derive("retry-compaction"))).toEqual({ text: "go", images: [], skills: [], requestId: expect.any(String) });
  });

  it("does not walk back over a reset", () => {
    expect(retryOf(derive("retry-reset"))).toBeUndefined();
  });

  it("reaches the latest prompt, not the first", () => {
    expect(retryOf(derive("retry-steer"))).toEqual({ text: "steer", images: [], skills: [], requestId: expect.any(String) });
  });

  it("binds the request id to the failed run", () => {
    const entries = derive("retry-second-failure");
    expect(retryOf(entries)).toEqual({ text: "go", images: [], skills: [], requestId: `retry:${entries.at(-1)!.id}` });
  });
});

describe("splitSubagentCalls", () => {
  it("lifts subagent calls out of steps and drops emptied steps", () => {
    const cotView = SPLIT_CASES.find((c) => c.name === "split-hand")!.cot;
    const { view: splitView, subagents } = splitSubagentCalls(cotView);
    expect(subagents).toEqual([
      { key: "1-tools-0/c1", tool: { toolCallId: "c1", toolName: "subagent", state: "output-available" } },
      { key: "1-tools-2/c3", tool: { toolCallId: "c3", toolName: "subagent", state: "output-available" } },
    ]);
    expect(splitView.steps).toEqual([
      { kind: "tools", id: "1-tools-0", tools: [{ toolCallId: "c2", toolName: "read", state: "output-available" }], live: false },
      { kind: "interim", id: "1-text-1", text: "looking" },
    ]);
  });

  it("recomputes a lifted active call's state when nothing is still running", () => {
    const cotView = SPLIT_CASES.find((c) => c.name === "split-settles-active")!.cot;
    const { view: splitView } = splitSubagentCalls(cotView);
    const step = splitView.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(step.tools.map((tool) => tool.toolName)).toEqual(["read"]);
    expect(step.activeToolCallId).toBeUndefined();
    expect(step.live).toBe(false);
  });

  it("hands activeToolCallId to the next still-pending call", () => {
    const cotView = SPLIT_CASES.find((c) => c.name === "split-hands-active")!.cot;
    const { view: splitView } = splitSubagentCalls(cotView);
    const step = splitView.steps.find((s) => s.kind === "tools")!;
    if (step.kind !== "tools") return;
    expect(step.tools.map((tool) => tool.toolName)).toEqual(["read", "read"]);
    expect(step.activeToolCallId).toBe("c3");
    expect(step.live).toBe(true);
  });

  it("keys repeated subagent call ids by step", () => {
    const cotView = SPLIT_CASES.find((c) => c.name === "split-dup-callid")!.cot;
    const { subagents } = splitSubagentCalls(cotView);
    const keys = subagents.map((subagent) => subagent.key);
    // Both rounds reuse the call id "c1" — the step id keeps the keys distinct.
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toMatch(/^\d+-tools-0\/c1$/);
    expect(subagents[0]!.tool.argsText).toBe('{"task":"one"}');
  });
});
