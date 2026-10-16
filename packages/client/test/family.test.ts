import { describe, expect, it } from "vitest";
import { organize, findConversation } from "@pinomad/protocol/organization.ts";
import type { ConversationNode, Organized } from "@pinomad/protocol/organization.ts";
import { displayName, familyStatus, familyUpdatedAt, forksAt, relativeTime, rootOf, taskGroupsOf, threadsOf } from "../src/family.ts";
import {
  DISPLAY_NAME_CASES,
  FAMILY_CASES,
  FORKS_AT_CASES,
  NODE_QUERIES,
  RELATIVE_TIME_CASES,
  ROOT_OF_CASES,
  family_case,
  type FamilyInput,
} from "./family-cases.ts";

const organizedOf = (input: FamilyInput): Organized =>
  organize(input.index as never, input.summaries as never[]);

const nodeOf = (family: string, id: number): ConversationNode =>
  findConversation(organizedOf(family_case(family)), id as never)!;

describe("familyStatus", () => {
  it("is undefined when the whole family is idle", () => {
    expect(familyStatus(nodeOf("idle", 1))).toBeUndefined();
  });

  it("a needs-answer in a grandchild beats a failed root", () => {
    expect(familyStatus(nodeOf("grandchild-needs-answer", 1))).toBe("needs-answer");
  });

  it("failed beats running anywhere in the family", () => {
    expect(familyStatus(nodeOf("failed-beats-running", 1))).toBe("failed");
  });

  it("an unknown status can win an otherwise-statusless family", () => {
    expect(familyStatus(nodeOf("unknown-status-wins", 1))).toBe("weird-status");
  });
});

describe("familyUpdatedAt", () => {
  it("is the newest updatedAt across the family, skipping conversations without one", () => {
    expect(familyUpdatedAt(nodeOf("updated-at", 1))).toBe(300);
    expect(familyUpdatedAt(nodeOf("idle", 1))).toBeUndefined();
  });
});

describe("displayName", () => {
  it("uses the subagent's label when it has one", () => {
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "subagent-label")!.summary as never)).toBe("Audit auth");
  });

  it("strips the working-directory boilerplate from a task title", () => {
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "subagent-strips-prefix")!.summary as never)).toBe(
      "audit the auth flow",
    );
  });

  it("falls back to Subagent without label or title", () => {
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "subagent-fallback")!.summary as never)).toBe("Subagent");
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "subagent-empty-title")!.summary as never)).toBe("Subagent");
  });

  it("keeps ordinary titles, New conversation when untitled, Conversation when absent", () => {
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "title")!.summary as never)).toBe("what broke?");
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "fork-untitled")!.summary as never)).toBe(
      "New conversation",
    );
    expect(displayName(DISPLAY_NAME_CASES.find((c) => c.name === "absent")!.summary as never)).toBe("Conversation");
  });
});

describe("forksAt", () => {
  const organized = organizedOf(family_case("fork-anchors"));

  it("returns the direct fork children anchored at an entry — including legacy nested forks", () => {
    expect(forksAt(organized, 1 as never, "10")).toEqual([2]);
    // A fork shown in the panel resolves its own children the same way.
    expect(forksAt(organized, 2 as never, "11")).toEqual([3]);
    // Only direct children anchor: B's entry does not belong to the root.
    expect(forksAt(organized, 1 as never, "11")).toEqual([]);
    expect(forksAt(organized, 42 as never, "10")).toEqual([]);
  });

  it("covers the same queries the vector generator emits", () => {
    for (const c of FORKS_AT_CASES) {
      const result = forksAt(organizedOf(family_case(c.family)), c.conversationId as never, c.entryId);
      expect(result.length, c.name).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("rootOf", () => {
  const organized = organizedOf(family_case("sub-in-fork"));

  it("walks parent links up to the top-level conversation", () => {
    for (const c of ROOT_OF_CASES) {
      expect(rootOf(organized, c.id as never)?.summary.id, c.name).toBe(c.id === 42 ? undefined : c.id === 9 ? 9 : 1);
    }
  });
});

describe("threadsOf / taskGroupsOf", () => {
  it("lists the family's forks and groups subagents by owner", () => {
    const root = nodeOf("family-tree", 1);
    expect(threadsOf(root).map((n) => n.summary.id)).toEqual([2, 5]);
    const groups = taskGroupsOf(root);
    expect(groups.map((group) => group.label)).toEqual(["This conversation", "worktree fork"]);
    expect(groups[0]!.tasks.map((n) => n.summary.id)).toEqual([4]);
    expect(groups[1]!.tasks.map((n) => n.summary.id)).toEqual([6]);
  });

  it("is empty for a conversation with no children", () => {
    const bare = nodeOf("sub-in-fork", 9);
    expect(threadsOf(bare)).toEqual([]);
    expect(taskGroupsOf(bare)).toEqual([]);
  });

  it("walks legacy trees: several forks per message and forks nested inside forks", () => {
    const legacy = nodeOf("legacy-nested-forks", 7);
    // Depth-first: a nested fork follows its parent fork, then siblings.
    expect(threadsOf(legacy).map((n) => n.summary.id)).toEqual([8, 9, 11]);
    const groups = taskGroupsOf(legacy);
    expect(groups.map((group) => group.label)).toEqual(["nested"]);
    expect(groups[0]!.tasks.map((n) => n.summary.id)).toEqual([10]);
  });
});

describe("relativeTime", () => {
  it("buckets into now / minutes / hours / days", () => {
    const expectOf = (name: string) => RELATIVE_TIME_CASES.find((c) => c.name === name)!;
    expect(relativeTime(expectOf("now-59s").at, expectOf("now-59s").now)).toBe("now");
    expect(relativeTime(expectOf("1m").at, expectOf("1m").now)).toBe("1m");
    expect(relativeTime(expectOf("5m").at, expectOf("5m").now)).toBe("5m");
    expect(relativeTime(expectOf("59m").at, expectOf("59m").now)).toBe("59m");
    expect(relativeTime(expectOf("1h").at, expectOf("1h").now)).toBe("1h");
    expect(relativeTime(expectOf("3h").at, expectOf("3h").now)).toBe("3h");
    expect(relativeTime(expectOf("1d").at, expectOf("1d").now)).toBe("1d");
    expect(relativeTime(expectOf("2d").at, expectOf("2d").now)).toBe("2d");
  });

  it("clamps a future timestamp to now", () => {
    const c = RELATIVE_TIME_CASES.find((x) => x.name === "future")!;
    expect(relativeTime(c.at, c.now)).toBe("now");
  });
});

describe("shared cases", () => {
  it("every family input organizes without throwing", () => {
    for (const input of FAMILY_CASES) {
      expect(() => organizedOf(input), input.name).not.toThrow();
    }
  });

  it("node queries resolve", () => {
    for (const query of NODE_QUERIES) {
      expect(findConversation(organizedOf(family_case(query.family)), query.id as never), query.name).toBeDefined();
    }
  });
});
