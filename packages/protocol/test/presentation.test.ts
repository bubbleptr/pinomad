import { describe, expect, it } from "vitest";
import { classify } from "../src/presentation.ts";

const todo = { items: [{ text: "Ship it", status: "pending" }] };
const approval = { requests: [{ id: "r1", title: "Deploy", requestedAt: 1 }] };

describe("classify", () => {
  it("returns the typed view for a conforming todo document", () => {
    expect(classify("pinomad.todo", todo)).toEqual({ type: "pinomad.todo", value: todo });
  });

  it("returns the typed view for a conforming approval document", () => {
    expect(classify("pinomad.approval", approval)).toEqual({ type: "pinomad.approval", value: approval });
  });

  it("tolerates extension-private fields on stored requests", () => {
    const value = { requests: [{ id: "r1", title: "Deploy", requestedAt: 1, waitTask: 7 }] };
    expect(classify("pinomad.approval", value)).toEqual({ type: "pinomad.approval", value });
  });

  it.each([
    ["a bad item status", { items: [{ text: "Ship it", status: "unknown" }] }],
    ["a missing field", { items: [{ status: "pending" }] }],
    ["a non-object", "not a todo"],
  ])("falls back on %s despite the declared presentation", (_label, value) => {
    expect(classify("pinomad.todo", value)).toEqual({ type: "fallback", value });
    expect(classify("pinomad.approval", value)).toEqual({ type: "fallback", value });
  });

  it("falls back when no presentation is declared", () => {
    expect(classify(undefined, todo)).toEqual({ type: "fallback", value: todo });
  });

  it("falls back on a presentation string a newer host might send", () => {
    const value = { requests: [] };
    expect(classify("pinomad.progress" as never, value)).toEqual({ type: "fallback", value });
  });
});
