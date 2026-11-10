import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { describe, expect, it } from "vitest";
import { conversationName, subagentMessaging } from "./subagent.ts";

const subagent = (patch: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 5 as ConversationId,
  kind: "subagent",
  label: "Write regression tests",
  name: "parser-tests",
  ...patch,
});

describe("subagentMessaging", () => {
  it("stays read-only on a host without subagent messages", () => {
    expect(subagentMessaging(subagent(), 32)).toBe("read-only");
  });

  it("stays read-only for a subagent from before names", () => {
    expect(subagentMessaging(subagent({ name: undefined }), 33)).toBe("read-only");
  });

  it("waits for a running foreground subagent's call to end", () => {
    expect(subagentMessaging(subagent({ lifecycle: "foreground", status: "running" }), 33)).toBe("in-call");
    // Absent lifecycle is foreground.
    expect(subagentMessaging(subagent({ status: "running" }), 33)).toBe("in-call");
  });

  it("opens an idle foreground subagent and a running background one", () => {
    expect(subagentMessaging(subagent({ lifecycle: "foreground" }), 33)).toBe("open");
    expect(subagentMessaging(subagent({ lifecycle: "foreground", status: "failed" }), 33)).toBe("open");
    expect(subagentMessaging(subagent({ lifecycle: "background", status: "running" }), 33)).toBe("open");
  });
});

describe("conversationName", () => {
  it("names a subagent by its name, falling back to its label", () => {
    expect(conversationName(subagent())).toBe("parser-tests");
    expect(conversationName(subagent({ name: undefined }))).toBe("Write regression tests");
  });
});
