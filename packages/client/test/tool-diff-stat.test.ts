import { describe, expect, it } from "vitest";
import { toolDiffStatFromResult } from "../src/tool-diff-stat.ts";
import { DIFF_STAT_CASES } from "./tools-cases.ts";

// Pi's `edit` tool result carries the change twice: `details.patch` is a
// standard single-file unified patch (the authority), `details.diff` is Pi's
// display rendering ("+221  code", "-219  code", " 217  code", "     ...").
// write returns no details at all, so it never gets stats.

const caseInput = (name: string) => DIFF_STAT_CASES.find((c) => c.name === name)!.input;

describe("toolDiffStatFromResult", () => {
  it("counts a single-hunk unified patch, ignoring ---/+++ headers", () => {
    expect(toolDiffStatFromResult(caseInput("single-hunk"))).toEqual({ additions: 4, deletions: 1 });
  });

  it("sums across hunks", () => {
    expect(toolDiffStatFromResult(caseInput("two-hunks"))).toEqual({ additions: 3, deletions: 3 });
  });

  it("counts a deleted line whose content begins with -- as a deletion", () => {
    expect(toolDiffStatFromResult(caseInput("dash-dash-line"))).toEqual({ additions: 1, deletions: 1 });
  });

  it("ignores '\\ No newline at end of file' markers", () => {
    expect(toolDiffStatFromResult(caseInput("no-newline-marker"))).toEqual({ additions: 1, deletions: 1 });
  });

  it("treats a missing hunk count as 1", () => {
    expect(toolDiffStatFromResult(caseInput("missing-count"))).toEqual({ additions: 1, deletions: 1 });
  });

  it("falls back to Pi's display diff when there is no patch", () => {
    expect(toolDiffStatFromResult(caseInput("display-diff"))).toEqual({ additions: 2, deletions: 1 });
  });

  it("prefers details.patch over details.diff when both exist", () => {
    expect(toolDiffStatFromResult(caseInput("patch-wins"))).toEqual({ additions: 1, deletions: 0 });
  });

  it("accepts the result serialized as a JSON string", () => {
    expect(toolDiffStatFromResult(caseInput("serialized-string"))).toEqual({ additions: 1, deletions: 1 });
  });

  it("returns undefined when there is nothing countable", () => {
    expect(toolDiffStatFromResult(caseInput("details-undefined"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("no-details"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("details-empty"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("context-only"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("patch-non-string"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("not-json"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("json-string"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("number"))).toBeUndefined();
    expect(toolDiffStatFromResult(caseInput("null"))).toBeUndefined();
  });
});
