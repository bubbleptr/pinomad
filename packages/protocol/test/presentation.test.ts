import { describe, expect, it } from "vitest";
import { classify } from "../src/presentation.ts";

const todo = { items: [{ text: "Ship it", status: "pending" }] };
const question = {
  requests: [
    {
      id: "r1",
      askedAt: 1,
      questions: [{ header: "Pick one", question: "Which way?", options: [{ label: "A" }, { label: "B" }] }],
    },
  ],
};

describe("classify", () => {
  it("returns the typed view for a conforming todo document", () => {
    expect(classify("pinomad.todo", todo)).toEqual({ type: "pinomad.todo", value: todo });
  });

  it("returns the typed view for a conforming question document", () => {
    expect(classify("pinomad.question", question)).toEqual({ type: "pinomad.question", value: question });
  });

  it("tolerates extension-private fields on stored requests", () => {
    const value = {
      requests: [{ id: "r1", askedAt: 1, waitTask: 7, questions: [{ header: "h", question: "q", options: [{ label: "a" }, { label: "b" }] }] }],
    };
    expect(classify("pinomad.question", value)).toEqual({ type: "pinomad.question", value });
  });

  it("accepts Durable's edit details shape, which carries fields beyond the patch", () => {
    const details = { patch: "@@ -1 +1 @@\n-a\n+b\n", diff: {}, firstChangedLine: 1 };
    expect(classify("pinomad.diff", details)).toEqual({ type: "pinomad.diff", value: details });
    expect(classify("pinomad.diff", { noPatch: true })).toEqual({ type: "fallback", value: { noPatch: true } });
  });

  it.each([
    ["a bad item status", { items: [{ text: "Ship it", status: "unknown" }] }],
    ["a missing field", { items: [{ status: "pending" }] }],
    ["a non-object", "not a todo"],
  ])("falls back on %s despite the declared presentation", (_label, value) => {
    expect(classify("pinomad.todo", value)).toEqual({ type: "fallback", value });
    expect(classify("pinomad.question", value)).toEqual({ type: "fallback", value });
  });

  it("falls back on a malformed question doc", () => {
    expect(classify("pinomad.question", { requests: [{ id: "r1" }] })).toEqual({ type: "fallback", value: { requests: [{ id: "r1" }] } });
    expect(classify("pinomad.question", "nope")).toEqual({ type: "fallback", value: "nope" });
  });

  it("falls back when no presentation is declared", () => {
    expect(classify(undefined, todo)).toEqual({ type: "fallback", value: todo });
  });

  it("falls back on a presentation string a newer host might send", () => {
    const value = { requests: [] };
    expect(classify("pinomad.progress" as never, value)).toEqual({ type: "fallback", value });
  });
});
