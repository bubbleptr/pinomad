import { describe, expect, it } from "vitest";
import { normalizeToolName, toolKindFromName, toolKindFromTools } from "../src/tool-item.ts";
import type { ToolItem } from "../src/tool-item.ts";
import { TOOL_KIND_SETS, TOOL_NAME_CASES } from "./tools-cases.ts";

function tool(name?: string): ToolItem {
  return { state: "output-available", ...(name ? { toolName: name } : {}) };
}

const caseInput = <T>(cases: readonly { name: string; input: T }[], name: string) => cases.find((c) => c.name === name)!.input;

describe("toolKindFromName", () => {
  it("classifies shell, search, web, file, and edit tools", () => {
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "bash"))).toBe("shell");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "shell"))).toBe("shell");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "grep"))).toBe("search");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "find"))).toBe("search");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "web_search"))).toBe("web");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "webfetch"))).toBe("web");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "read"))).toBe("file");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "read_file"))).toBe("file");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "edit"))).toBe("edit");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "write"))).toBe("edit");
  });

  it("normalizes case and hyphens, and falls back to a generic tool", () => {
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "case-normalized"))).toBe("shell");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "hyphen-normalized"))).toBe("web");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "sleep"))).toBe("tool");
    expect(toolKindFromName(caseInput(TOOL_NAME_CASES, "missing"))).toBe("tool");
  });
});

describe("normalizeToolName", () => {
  it("trims, lowercases, and maps hyphens to underscores", () => {
    expect(normalizeToolName(" Web-Search ")).toBe("web_search");
    expect(normalizeToolName(undefined)).toBe("");
  });
});

describe("toolKindFromTools", () => {
  it("uses the shared kind when every call is the same, otherwise the generic tool", () => {
    expect(toolKindFromTools(caseInput(TOOL_KIND_SETS, "same-kind").map(tool))).toBe("shell");
    expect(toolKindFromTools(caseInput(TOOL_KIND_SETS, "mixed").map(tool))).toBe("tool");
    expect(toolKindFromTools(caseInput(TOOL_KIND_SETS, "generic").map(tool))).toBe("tool");
  });
});
