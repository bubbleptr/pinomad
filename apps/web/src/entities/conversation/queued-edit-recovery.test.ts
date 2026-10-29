import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  clearQueuedEditRecovery,
  saveQueuedEditRecovery,
  takeQueuedEditRecovery,
  type QueuedEditRecovery,
} from "./queued-edit-recovery.ts";

const id = (value: number): ConversationId => value as ConversationId;
const recovery: QueuedEditRecovery = {
  text: "edit me",
  skills: ["review"],
  images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  attachments: [],
};

beforeEach(() => {
  clearQueuedEditRecovery("host-a", id(1));
  clearQueuedEditRecovery("host-b", id(1));
});

describe("queued edit recovery", () => {
  it("keeps the same conversation id apart across hosts", () => {
    saveQueuedEditRecovery("host-a", id(1), recovery);
    expect(takeQueuedEditRecovery("host-b", id(1))).toBeUndefined();
    expect(takeQueuedEditRecovery("host-a", id(1))).toEqual(recovery);
    // Consumed once: the next mount must not restore the same draft again.
    expect(takeQueuedEditRecovery("host-a", id(1))).toBeUndefined();
  });

  it("drops a recovery when the mounted composer already restored it", () => {
    saveQueuedEditRecovery("host-a", id(1), recovery);
    clearQueuedEditRecovery("host-a", id(1));
    expect(takeQueuedEditRecovery("host-a", id(1))).toBeUndefined();
  });
});
