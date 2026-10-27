import { describe, expect, it } from "vitest";
import { messageTime } from "./chat-time.ts";

const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const at = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).getTime();

describe("messageTime", () => {
  it("shows only the time for a message from today", () => {
    const value = messageTime(at(2026, 10, 28, 14, 31), NOW, "en-US")!;
    expect(value.label).toBe("2:31 PM");
    expect(value.label).not.toContain("2026");
    expect(value.full).toContain("2026");
    expect(value.full).toContain("2:31");
  });

  it("adds the date for another day in the same year", () => {
    const value = messageTime(at(2026, 10, 27, 14, 31), NOW, "en-US")!;
    expect(value.label).toBe("Oct 27, 2:31 PM");
    expect(value.label).not.toContain("2026");
  });

  it("adds the year across years", () => {
    const value = messageTime(at(2025, 12, 31, 23, 59), NOW, "en-US")!;
    expect(value.label).toBe("Dec 31, 2025, 11:59 PM");
  });

  it("uses the calendar day, not a rolling 24 hours", () => {
    const beforeMidnight = at(2026, 10, 27, 23, 59);
    const now = at(2026, 10, 28, 0, 1);
    expect(messageTime(beforeMidnight, now, "en-US")!.label).toContain("Oct 27");
  });

  it("treats a non-finite stamp as absent", () => {
    expect(messageTime(Number.NaN, NOW, "en-US")).toBeUndefined();
    expect(messageTime(Number.POSITIVE_INFINITY, NOW, "en-US")).toBeUndefined();
  });
});
