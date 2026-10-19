// Shared contextUsage inputs: context-usage.test.ts asserts on these cases
// and rust-vectors.ts serializes the same inputs for the Rust replay — one
// table, no copies.
import type { ConversationView } from "@earendil-works/pi-durable";
import { entry, user, view } from "./cot-view-cases.ts";

const assistant = (usage: object | undefined, stopReason = "stop") =>
  entry("pi.assistant", {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason,
    ...(usage === undefined ? {} : { usage }),
    timestamp: 0,
  });

const usage = (input: number, output = 0, extra: object = {}) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  ...extra,
});

export interface ContextUsageCase {
  readonly name: string;
  readonly view: ConversationView;
  readonly contextWindow?: number;
}

export const CONTEXT_USAGE_CASES: ContextUsageCase[] = [
  { name: "empty", view: view([]), contextWindow: 200000 },
  { name: "no-assistant", view: view([user("hi")]), contextWindow: 200000 },
  {
    name: "latest-wins",
    view: view([
      assistant(usage(12000, 200)),
      assistant(usage(78000, 6000)),
      // A queued user turn sits after the last reply; the scan passes it.
      user("again"),
    ]),
    contextWindow: 200000,
  },
  {
    name: "skips-aborted-error-zero",
    view: view([
      assistant(usage(12000, 200)),
      assistant(usage(0), "error"),
      assistant(usage(50000, 5000), "aborted"),
      assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    ]),
    contextWindow: 200000,
  },
  {
    name: "usage-missing",
    view: view([assistant(usage(8000)), assistant(undefined)]),
    contextWindow: 200000,
  },
  {
    name: "compaction-tail",
    view: view([assistant(usage(84000)), entry("pi.compaction")]),
    contextWindow: 200000,
  },
  {
    name: "reset-tail",
    view: view([assistant(usage(84000)), entry("pi.reset")]),
    contextWindow: 200000,
  },
  {
    name: "reply-after-compaction",
    view: view([assistant(usage(50000)), entry("pi.compaction"), assistant(usage(11000, 1000))]),
    contextWindow: 200000,
  },
  {
    name: "components-sum",
    // totalTokens 0 is falsy upstream: the four components add up instead.
    view: view([assistant({ input: 60000, output: 20000, cacheRead: 3000, cacheWrite: 1000, totalTokens: 0 })]),
    contextWindow: 200000,
  },
  { name: "no-window", view: view([assistant(usage(84000))]) },
  { name: "zero-window", view: view([assistant(usage(84000))]), contextWindow: 0 },
  {
    name: "overflow",
    view: view([assistant(usage(250000))]),
    contextWindow: 200000,
  },
];
