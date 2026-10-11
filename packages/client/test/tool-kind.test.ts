import { describe, expect, it } from "vitest";
import { toolKindFromName, toolKindFromTools } from "../src/tool-item.ts";
import type { ToolItem } from "../src/tool-item.ts";

function tool(name?: string): ToolItem {
  return { state: "output-available", ...(name ? { toolName: name } : {}) };
}

describe("toolKindFromName", () => {
  it("classifies shell, search, web, file, and edit tools", () => {
    expect(toolKindFromName("bash")).toBe("shell");
    expect(toolKindFromName("shell")).toBe("shell");
    expect(toolKindFromName("grep")).toBe("search");
    expect(toolKindFromName("find")).toBe("search");
    expect(toolKindFromName("web_search")).toBe("web");
    expect(toolKindFromName("webfetch")).toBe("web");
    expect(toolKindFromName("read")).toBe("file");
    expect(toolKindFromName("read_file")).toBe("file");
    expect(toolKindFromName("edit")).toBe("edit");
    expect(toolKindFromName("write")).toBe("edit");
  });

  it("normalizes case and hyphens, and falls back to a generic tool", () => {
    expect(toolKindFromName("Bash")).toBe("shell");
    expect(toolKindFromName("web-search")).toBe("web");
    expect(toolKindFromName("sleep")).toBe("tool");
    expect(toolKindFromName(undefined)).toBe("tool");
  });
});

describe("toolKindFromTools", () => {
  it("uses the shared kind when every call is the same, otherwise the generic tool", () => {
    expect(toolKindFromTools([tool("bash"), tool("shell")])).toBe("shell");
    expect(toolKindFromTools([tool("bash"), tool("read")])).toBe("tool");
    expect(toolKindFromTools([tool("sleep")])).toBe("tool");
  });
});
