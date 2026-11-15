import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { groupInboxTasks, inboxRunIds, inboxTaskState } from "../src/inbox.ts";
import { INBOX_GROUP_CASES, INBOX_STATE_CASES, task } from "./inbox-cases.ts";

describe("inboxTaskState", () => {
  for (const c of INBOX_STATE_CASES) {
    it(c.name, () => {
      expect(inboxTaskState(c.task, c.summary)).toBe(c.expect);
    });
  }
});

describe("groupInboxTasks", () => {
  for (const c of INBOX_GROUP_CASES) {
    it(c.name, () => {
      expect(groupInboxTasks(c.tasks, c.summaries).map((group) => [group.group, group.tasks.map((each) => each.id)])).toEqual(c.expect);
    });
  }
});

describe("inboxRunIds", () => {
  it("collects every task conversation, not the intake", () => {
    const ids = inboxRunIds({
      inboxes: [
        {
          project: "/p",
          intake: 9 as ConversationId,
          tasks: [task("a", { conversationId: 3 as ConversationId }), task("b")],
          threads: {},
          rules: "",
          followUps: [],
        },
      ],
    });
    expect([...ids]).toEqual([3]);
    expect(inboxRunIds(null).size).toBe(0);
  });
});
