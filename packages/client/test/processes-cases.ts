// Cases for the background-process vector (ADR-0045): the status wording
// and the list order the Rust core must match. Inputs are wire values.
import type { ProcessInfo, ProcessState } from "@pinomad/protocol/processes.ts";

export const PROCESS_STATUS_CASES: { name: string; state: ProcessState }[] = [
  { name: "starting", state: "starting" },
  { name: "running", state: "running" },
  { name: "lost", state: "lost" },
  { name: "stopped-agent", state: { stopped: "agent" } },
  { name: "stopped-user", state: { stopped: "user" } },
  { name: "stopped-archive", state: { stopped: "archive" } },
  { name: "stopped-shutdown", state: { stopped: "shutdown" } },
  { name: "failed", state: { failed: "port 3000 is taken" } },
  { name: "exited-zero", state: { exited: 0 } },
  { name: "exited-failure", state: { exited: 1 } },
  { name: "exited-no-code", state: { exited: null } },
  { name: "exited-signal", state: { exited: null, signal: "SIGTERM" } },
];

const process = (
  id: string,
  startedAt: number,
  state: ProcessState,
  endedAt?: number,
): ProcessInfo => ({
  id,
  owner: 3 as never,
  name: id,
  command: `run ${id}`,
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
  state,
});

export const PROCESS_ORDER_CASES: { name: string; processes: ProcessInfo[] }[] = [
  {
    name: "live-first-then-ended-newest",
    processes: [
      process("old", 10, { exited: 0 }, 20),
      process("run", 30, "running"),
      process("lost", 5, "lost", 40),
      process("start", 50, "starting"),
      process("new", 60, { stopped: "user" }, 70),
    ],
  },
  {
    // Equal endedAt keeps the host's order (stable sort).
    name: "same-ended-at-keeps-host-order",
    processes: [
      process("same-a", 10, { exited: 0 }, 50),
      process("same-b", 20, { exited: 1 }, 50),
      process("same-c", 5, { stopped: "agent" }, 50),
    ],
  },
  {
    // Missing endedAt falls back to startedAt.
    name: "missing-ended-at-uses-started-at",
    processes: [
      process("no-end-old", 10, { exited: 0 }),
      process("ended", 1, { stopped: "user" }, 5),
      process("no-end-new", 30, "lost"),
    ],
  },
  {
    name: "all-live-keeps-host-order",
    processes: [
      process("run-b", 20, "running"),
      process("start-a", 10, "starting"),
    ],
  },
];
