import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { describe, expect, it } from "vitest";
import { canStopSubagent, conversationName } from "./subagent.ts";

const subagent = (patch: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 5 as ConversationId,
  kind: "subagent",
  label: "Write regression tests",
  name: "parser-tests",
  ...patch,
});

describe("canStopSubagent", () => {
  it("offers Stop for a named subagent at work, foreground or background", () => {
    expect(canStopSubagent(subagent({ status: "running" }), 33)).toBe(true);
    expect(canStopSubagent(subagent({ lifecycle: "background", status: "running" }), 33)).toBe(true);
  });

  it("has nothing to stop once it is idle or has failed", () => {
    expect(canStopSubagent(subagent(), 33)).toBe(false);
    expect(canStopSubagent(subagent({ status: "failed" }), 33)).toBe(false);
  });

  it("stays without Stop on an older host and for a subagent from before names", () => {
    expect(canStopSubagent(subagent({ status: "running" }), 32)).toBe(false);
    expect(canStopSubagent(subagent({ name: undefined, status: "running" }), 33)).toBe(false);
  });
});

describe("conversationName", () => {
  it("names a subagent by its name, falling back to its label", () => {
    expect(conversationName(subagent())).toBe("parser-tests");
    expect(conversationName(subagent({ name: undefined }))).toBe("Write regression tests");
  });
});
