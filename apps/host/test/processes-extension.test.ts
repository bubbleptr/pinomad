// The processes extension (ADR-0004, ADR-0045): four model-only tools, the
// root document, and a start that memoizes its id before the runtime is asked
// to spawn anything.
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ProcessInfo } from "@pinomad/protocol/processes.ts";
import { createProcesses } from "../src/extensions/processes.ts";
import type { ProcessRuntime } from "../src/processes.ts";

const context = {} as never;

function processInfo(id: string, name = "monitor"): ProcessInfo {
  return {
    id,
    owner: 1 as never,
    name,
    command: "sleep 30",
    startedAt: 1,
    state: "running",
  };
}

function apiWithMemo(): { api: ToolExecutionApi; memoCalls: unknown[] } {
  const memoCalls: unknown[] = [];
  const stored = new Map<string, unknown>();
  const api = {
    conversationId: 1,
    agent: async () => ({ cwd: "/tmp" }),
    memo: async (name: string, candidate: unknown) => {
      memoCalls.push(candidate);
      if (stored.has(name)) return stored.get(name);
      stored.set(name, candidate);
      return candidate;
    },
  } as unknown as ToolExecutionApi;
  return { api, memoCalls };
}

describe("processes extension", () => {
  it("registers four model tools and the root document", () => {
    const runtime = {} as ProcessRuntime;
    const extension = createProcesses({ runtime });
    const tools = extension.extension.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(["process_start", "process_output", "process_stop", "process_list"]);
    for (const tool of tools) expect(tool.callers).toEqual(["model"]);
    expect(extension.docs?.[0]).toMatchObject({ presentation: "pinomad.processes" });
  });

  it("keeps the document but registers no tools when the pty is missing", () => {
    const extension = createProcesses({});
    expect(extension.extension.tools ?? []).toEqual([]);
    expect(extension.docs?.[0]).toMatchObject({ presentation: "pinomad.processes" });
  });

  it("memoizes the process id before starting and reuses it on a replay", async () => {
    const start = vi.fn(async (input: { id?: string; name: string }) => processInfo(input.id!, input.name));
    const runtime = { start } as unknown as ProcessRuntime;
    const extension = createProcesses({ runtime });
    const tool = (extension.extension.tools ?? []).find((candidate) => candidate.name === "process_start")!;
    const { api, memoCalls } = apiWithMemo();

    const first = await tool.execute({ command: "sleep 30" }, api as never, context);
    const second = await tool.execute({ command: "sleep 30" }, api as never, context);
    expect(memoCalls).toHaveLength(2);
    const ids = start.mock.calls.map(([input]) => input.id);
    expect(ids[0]).toBe(ids[1]);
    expect(first.details).toEqual({ id: ids[0], name: "sleep 30" });
    expect(second.details).toEqual({ id: ids[0], name: "sleep 30" });
  });
});
