import type { QueueItem } from "@pinomad/client/chat.ts";
import { describe, expect, it } from "vitest";
import { reorderBefore } from "./queued-list.tsx";

const row = (id: number, mode: QueueItem["mode"] = "followUp"): QueueItem => ({
  id,
  mode,
  text: String(id),
  imageCount: 0,
  attachmentCount: 0,
  status: "sent",
});

describe("reorderBefore", () => {
  it("drops after a row as before the next queued input, skipping writes and the moved row", () => {
    const items = [row(1), row(2), row(3, "write"), row(4)];
    expect(reorderBefore(items, 1, 2, "after")).toBe(4);
    expect(reorderBefore(items, 4, 1, "after")).toBe(2);
  });

  it("drops after the last input with no before, so the host appends it", () => {
    const items = [row(1), row(2), row(3, "write")];
    expect(reorderBefore(items, 1, 2, "after")).toBeUndefined();
  });

  it("ignores local rows the host has not admitted", () => {
    const local: QueueItem = { ...row(0), id: undefined, requestId: "r", status: "unknown" };
    expect(reorderBefore([row(1), row(2), local], 1, 2, "after")).toBeUndefined();
  });
});
