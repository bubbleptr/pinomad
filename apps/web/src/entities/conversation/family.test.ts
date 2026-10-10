import { describe, expect, it } from "vitest";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { displayName, familyStatus, familyUpdatedAt, relativeTime } from "./family.ts";

const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 0 as ConversationSummary["id"],
  kind: "conversation",
  ...over,
});

const node = (over: Partial<ConversationSummary> = {}, children: ConversationNode[] = []): ConversationNode => ({
  summary: summary(over),
  children,
});

describe("familyStatus", () => {
  it("is undefined when the whole family is idle", () => {
    expect(familyStatus(node({}, [node(), node({ kind: "subagent" })]))).toBeUndefined();
  });

  it("a needs-answer in a grandchild beats a failed root", () => {
    const root = node({ status: "failed" }, [
      node({ status: "running" }, [node({ kind: "fork", status: "needs-answer" })]),
    ]);
    expect(familyStatus(root)).toBe("needs-answer");
  });

  it("failed beats running anywhere in the family", () => {
    expect(familyStatus(node({ status: "running" }, [node({ kind: "subagent", status: "failed" })]))).toBe("failed");
    expect(familyStatus(node({ status: "running" }))).toBe("running");
  });
});

describe("familyUpdatedAt", () => {
  it("is the newest updatedAt across the family, skipping conversations without one", () => {
    const root = node({ updatedAt: 100 }, [
      node({ kind: "fork", updatedAt: 300 }),
      node({ kind: "subagent" }),
      node({ updatedAt: 200 }),
    ]);
    expect(familyUpdatedAt(root)).toBe(300);
    expect(familyUpdatedAt(node({}, [node({ kind: "fork" })]))).toBeUndefined();
  });
});

describe("displayName", () => {
  it("uses the subagent's label when it has one", () => {
    expect(displayName(summary({ kind: "subagent", label: "Audit auth", title: "In the working directory /tmp/x, do things" }))).toBe(
      "Audit auth",
    );
  });

  it("strips the working-directory boilerplate from a task title", () => {
    expect(displayName(summary({ kind: "subagent", title: "  in the working directory /tmp/x, audit the auth flow" }))).toBe(
      "audit the auth flow",
    );
  });

  it("falls back to Subagent without label or title", () => {
    expect(displayName(summary({ kind: "subagent" }))).toBe("Subagent");
    expect(displayName(summary({ kind: "subagent", title: "In the working directory /tmp/x," }))).toBe("Subagent");
  });

  it("keeps ordinary titles, New conversation when untitled, Conversation when absent", () => {
    expect(displayName(summary({ title: "what broke?" }))).toBe("what broke?");
    expect(displayName(summary({ kind: "fork" }))).toBe("New conversation");
    expect(displayName(undefined)).toBe("Conversation");
  });
});

describe("relativeTime", () => {
  const now = 1_800_000_000_000;
  it("buckets into now / minutes / hours / days", () => {
    expect(relativeTime(now - 59_000, now)).toBe("now");
    expect(relativeTime(now - 60_000, now)).toBe("1m");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m");
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h");
    expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe("3h");
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d");
    expect(relativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe("2d");
  });
});
