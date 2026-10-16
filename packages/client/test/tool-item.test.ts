import { describe, expect, it } from "vitest";
import { toolTarget } from "@pinomad/protocol/tool-target.ts";
import { formatToolDuration, toolDisplayName, toolTargetFromArgs } from "../src/tool-item.ts";
import { TOOL_DISPLAY_NAME_CASES, TOOL_DURATION_CASES, TOOL_TARGET_ARGS_CASES, TOOL_TARGET_CASES } from "./tools-cases.ts";

const caseInput = <T>(cases: readonly { name: string; input: T }[], name: string) => cases.find((c) => c.name === name)!.input;

describe("toolTargetFromArgs", () => {
  it("extracts the most specific common key from JSON args", () => {
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "path"))).toBe("src/index.ts");
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "file_path-with-extra"))).toBe("a.ts");
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "command"))).toBe("git diff --stat");
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "query"))).toBe("astryx tokens");
  });

  it("returns undefined for malformed, empty, or keyless args", () => {
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "missing"))).toBeUndefined();
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "not-json"))).toBeUndefined();
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "no-known-key"))).toBeUndefined();
    expect(toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "non-string"))).toBeUndefined();
  });

  it("truncates very long targets", () => {
    const target = toolTargetFromArgs(caseInput(TOOL_TARGET_ARGS_CASES, "long"));
    expect(target).toHaveLength(121);
    expect(target?.endsWith("…")).toBe(true);
  });
});

describe("toolTarget", () => {
  it("picks the first target-ish key and skips empty strings", () => {
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "priority"))).toBe("p.ts");
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "task"))).toBe("survey the codebase");
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "empty-string-skipped"))).toBe("ls");
  });

  it("returns undefined for non-objects and keyless objects", () => {
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "non-object"))).toBeUndefined();
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "null"))).toBeUndefined();
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "none"))).toBeUndefined();
  });

  it("truncates past 120 code units, pairs counting as two", () => {
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "truncate"))).toBe(`${"p".repeat(120)}…`);
    expect(toolTarget(caseInput(TOOL_TARGET_CASES, "truncate-pair"))).toBe(`${"🚀".repeat(60)}…`);
  });
});

describe("toolDisplayName", () => {
  it("reads mcp__<server>__<tool> as <server>/<tool>", () => {
    expect(toolDisplayName(caseInput(TOOL_DISPLAY_NAME_CASES, "mcp"))).toBe("playwright/screenshot");
    expect(toolDisplayName(caseInput(TOOL_DISPLAY_NAME_CASES, "mcp-extra-underscore"))).toBe("srv/a__b");
    expect(toolDisplayName(caseInput(TOOL_DISPLAY_NAME_CASES, "mcp-no-tool-sep"))).toBe("alone");
    expect(toolDisplayName(caseInput(TOOL_DISPLAY_NAME_CASES, "plain"))).toBe("read");
    expect(toolDisplayName(caseInput(TOOL_DISPLAY_NAME_CASES, "missing"))).toBeUndefined();
  });
});

describe("formatToolDuration", () => {
  it("formats sub-second as ms and seconds with one decimal", () => {
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "ms"))).toBe("45ms");
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "ms-round"))).toBe("1000ms");
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "s"))).toBe("3.2s");
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "s-60"))).toBe("60.0s");
  });

  it("picks the larger candidate on an exact half tie, like JS toFixed", () => {
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "s-tie-1.25"))).toBe("1.3s");
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "s-tie-2.25"))).toBe("2.3s");
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "s-tie-3.25"))).toBe("3.3s");
  });

  it("returns undefined for missing or invalid input", () => {
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "missing"))).toBeUndefined();
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "negative"))).toBeUndefined();
    expect(formatToolDuration(caseInput(TOOL_DURATION_CASES, "nan"))).toBeUndefined();
  });
});
