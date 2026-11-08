import { describe, expect, it } from "vitest";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import type { ProcessInfo } from "@pinomad/protocol/processes.ts";
import { activeProcesses, orderedProcesses, processExitCode, processesOf } from "../src/processes.ts";

const PROCESSES: ProcessInfo[] = [
  { id: "run", owner: 3 as never, name: "dev", command: "npm run dev", startedAt: 1, state: "running" },
  { id: "wait", owner: 3 as never, name: "build", command: "make", startedAt: 2, state: "starting" },
  { id: "done", owner: 3 as never, name: "test", command: "bun test", startedAt: 3, endedAt: 4, state: { exited: 0 } },
  { id: "lost", owner: 3 as never, name: "old", command: "sleep 1", startedAt: 5, state: "lost" },
];

const docs = (value: unknown): ExtensionDocView[] => [
  { kind: "pinomad.processes", presentation: "pinomad.processes", value: value as never },
];

describe("processesOf", () => {
  it("reads a valid document and drops a malformed one", () => {
    expect(processesOf(docs({ processes: PROCESSES })).map((process) => process.id)).toEqual([
      "run",
      "wait",
      "done",
      "lost",
    ]);
    expect(processesOf(docs({ processes: [{ id: "broken" }] }))).toEqual([]);
  });
});

describe("activeProcesses", () => {
  it("keeps starting and running entries only", () => {
    expect(activeProcesses(docs({ processes: PROCESSES })).map((process) => process.id)).toEqual(["run", "wait"]);
  });
});

describe("orderedProcesses", () => {
  it("keeps live entries first and lists ended ones newest first", () => {
    const ordered = orderedProcesses([
      { id: "old", owner: 3 as never, name: "old", command: "old", startedAt: 1, endedAt: 2, state: { exited: 0 } },
      { id: "run", owner: 3 as never, name: "run", command: "run", startedAt: 3, state: "running" },
      { id: "new", owner: 3 as never, name: "new", command: "new", startedAt: 4, endedAt: 9, state: { exited: 1 } },
      { id: "start", owner: 3 as never, name: "start", command: "start", startedAt: 5, state: "starting" },
    ]);
    expect(ordered.map((process) => process.id)).toEqual(["run", "start", "new", "old"]);
  });
});

describe("processExitCode", () => {
  it("reports the exit code of an exited process and nothing for the others", () => {
    expect(processExitCode({ exited: 0 })).toBe(0);
    expect(processExitCode({ exited: null, signal: "SIGKILL" })).toBeNull();
    expect(processExitCode("running")).toBeUndefined();
  });
});
