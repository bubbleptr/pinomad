import { describe, expect, it } from "vitest";
import type { CotStep } from "@pinomad/client/cot-view.ts";
import type { ToolItem } from "@pinomad/client/tool-item.ts";
import { segmentRun } from "./segment-run.ts";

function thinking(id: string, live = false): CotStep {
  return { kind: "thinking", id, text: "", live };
}

function interim(id: string, text: string): CotStep {
  return { kind: "interim", id, text };
}

function tools(id: string, items: ToolItem[], live = false): CotStep {
  return { kind: "tools", id, tools: items, live };
}

function call(toolName: string, toolCallId: string, state: ToolItem["state"] = "output-available"): ToolItem {
  return { toolName, toolCallId, state };
}

/** Each segment reduced to what the transcript renders from it. */
function shape(steps: CotStep[]) {
  return segmentRun(steps).map((segment) =>
    segment.kind === "interim"
      ? { interim: segment.text }
      : { trace: segment.steps.map((step) => step.id), counted: segment.counted.map((tool) => tool.toolCallId), live: segment.live },
  );
}

describe("segmentRun", () => {
  it("folds a run the model never narrated into one trace", () => {
    expect(
      shape([
        thinking("a-thinking-0"),
        tools("a-tools-1", [call("bash", "c1"), call("read", "c2")]),
        thinking("b-thinking-0"),
        tools("b-tools-1", [call("edit", "c3")]),
      ]),
    ).toEqual([{ trace: ["a-thinking-0", "a-tools-1", "b-thinking-0", "b-tools-1"], counted: ["c1", "c2", "c3"], live: false }]);
  });

  it("opens with prose when the run starts by talking", () => {
    expect(
      shape([interim("a-text-0", "Looking at the tests first."), tools("a-tools-1", [call("bash", "c1")])]),
    ).toEqual([{ interim: "Looking at the tests first." }, { trace: ["a-tools-1"], counted: ["c1"], live: false }]);
  });

  it("never emits an empty trace between two interims in a row", () => {
    expect(
      shape([
        tools("a-tools-0", [call("bash", "c1")]),
        interim("a-text-1", "First finding."),
        interim("b-text-0", "Second finding."),
        thinking("b-thinking-1"),
      ]),
    ).toEqual([
      { trace: ["a-tools-0"], counted: ["c1"], live: false },
      { interim: "First finding." },
      { interim: "Second finding." },
      { trace: ["b-thinking-1"], counted: [], live: false },
    ]);
  });

  // deriveRun turns the live partial's text into Interim Output as soon as a
  // call block follows it; the call is then the live tail.
  it("puts a streaming message's interim into the prose ahead of its live call", () => {
    expect(
      shape([
        tools("a-tools-0", [call("read", "c1")]),
        interim("live-text-0", "Now the fix."),
        tools("live-tools-1", [call("edit", "c2", "input-streaming")], true),
      ]),
    ).toEqual([
      { trace: ["a-tools-0"], counted: ["c1"], live: false },
      { interim: "Now the fix." },
      { trace: ["live-tools-1"], counted: ["c2"], live: true },
    ]);
  });

  it("marks only the trace still running as live", () => {
    expect(
      shape([
        tools("a-tools-0", [call("bash", "c1")]),
        interim("a-text-1", "Tests pass."),
        tools("b-tools-0", [call("bash", "c2")]),
        thinking("live-thinking-0", true),
      ]),
    ).toEqual([
      { trace: ["a-tools-0"], counted: ["c1"], live: false },
      { interim: "Tests pass." },
      { trace: ["b-tools-0", "live-thinking-0"], counted: ["c2"], live: true },
    ]);
  });

  // The todo card already says the list changed; counting the write again
  // would add a "Used a tool" to every planning run.
  it("keeps todo_write in the trace but out of its count", () => {
    const [segment] = segmentRun([
      tools("a-tools-0", [call("todo_write", "t1"), call("bash", "c1")]),
      tools("b-tools-0", [call("todo_write", "t2")]),
    ]);
    expect(segment).toMatchObject({ kind: "trace", counted: [{ toolCallId: "c1" }] });
    expect(segment?.kind === "trace" && segment.steps.flatMap((step) => (step.kind === "tools" ? step.tools : [])).map((tool) => tool.toolCallId)).toEqual(["t1", "c1", "t2"]);
  });

  // Only a write that landed reaches the card. A failed one changed nothing
  // there, so the row is the only place it shows up and it must count.
  it("counts a todo_write that failed", () => {
    const [segment] = segmentRun([tools("a-tools-0", [call("todo_write", "t1", "output-error"), call("todo_write", "t2")])]);
    expect(segment).toMatchObject({ kind: "trace", counted: [{ toolCallId: "t1", state: "output-error" }] });
  });

  // Keys are segment ordinals: the live partial's step ids change when it
  // commits ("live-tools-1" → "<entry>-tools-1"), and the row must not
  // remount and drop its open state when they do.
  it("keys segments by position so a committing step keeps its row", () => {
    const live = segmentRun([interim("a-text-0", "Go."), tools("live-tools-1", [call("bash", "c1", "input-available")], true)]);
    const committed = segmentRun([interim("a-text-0", "Go."), tools("b-tools-1", [call("bash", "c1")])]);
    expect(live.map((segment) => segment.key)).toEqual(committed.map((segment) => segment.key));
  });
});
