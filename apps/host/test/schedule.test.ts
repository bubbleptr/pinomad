// Schedule sources (ADR-0051 §10): the next fire of a daily, weekday, weekly
// or cron schedule in its own time zone, across DST changes.
import { describe, expect, it } from "vitest";
import { checkSchedule, nextFire } from "../src/schedule.ts";

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

describe("nextFire", () => {
  it("fires daily at the zone's wall time, after the given instant", () => {
    const daily = { kind: "daily", time: "08:00", timeZone: "Asia/Shanghai" } as const;
    // 08:00 in Shanghai is 00:00 UTC.
    expect(iso(nextFire(daily, at("2026-11-15T23:30:00Z")))).toBe("2026-11-16T00:00:00.000Z");
    // Exactly at a fire: the next one, never the same instant again.
    expect(iso(nextFire(daily, at("2026-11-16T00:00:00Z")))).toBe("2026-11-17T00:00:00.000Z");
  });

  it("skips weekends for weekdays and picks the day for weekly", () => {
    const zone = "Europe/Berlin";
    // Friday 2026-11-20 18:00 Berlin: the next weekday 09:00 is Monday.
    expect(iso(nextFire({ kind: "weekdays", time: "09:00", timeZone: zone }, at("2026-11-20T17:00:00Z")))).toBe("2026-11-23T08:00:00.000Z");
    // Wednesday (3) 10:30, from a Thursday.
    expect(iso(nextFire({ kind: "weekly", day: 3, time: "10:30", timeZone: zone }, at("2026-11-19T12:00:00Z")))).toBe("2026-11-25T09:30:00.000Z");
  });

  it("keeps the wall time across a DST change", () => {
    const zone = "America/New_York";
    const daily = { kind: "daily", time: "09:00", timeZone: zone } as const;
    // EDT before 2026-11-01, EST after.
    expect(iso(nextFire(daily, at("2026-10-31T14:00:00Z")))).toBe("2026-11-01T14:00:00.000Z");
    expect(iso(nextFire(daily, at("2026-10-30T14:00:00Z")))).toBe("2026-10-31T13:00:00.000Z");
  });

  it("moves a wall time the spring-forward gap skips to just after it, once", () => {
    // 2026-03-08 02:30 does not exist in New York: clocks go 02:00 → 03:00.
    const daily = { kind: "daily", time: "02:30", timeZone: "America/New_York" } as const;
    const fire = nextFire(daily, at("2026-03-08T05:00:00Z"));
    expect(iso(fire)).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
    expect(iso(nextFire(daily, fire))).toBe("2026-03-09T06:30:00.000Z");
  });

  it("fires an hour the fall-back repeats once, at its first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York: EDT (05:30Z), then EST (06:30Z).
    const daily = { kind: "daily", time: "01:30", timeZone: "America/New_York" } as const;
    const fire = nextFire(daily, at("2026-11-01T04:00:00Z"));
    expect(iso(fire)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextFire(daily, fire))).toBe("2026-11-02T06:30:00.000Z");
  });

  it("evaluates cron fields: lists, ranges, steps, and either day field when both are set", () => {
    const cron = (expression: string) => ({ kind: "cron", expression, timeZone: "UTC" }) as const;
    expect(iso(nextFire(cron("*/15 * * * *"), at("2026-11-15T10:07:00Z")))).toBe("2026-11-15T10:15:00.000Z");
    expect(iso(nextFire(cron("0 9-17/4 * * 1-5"), at("2026-11-16T13:00:00Z")))).toBe("2026-11-16T17:00:00.000Z");
    // Day 1 of the month or any Friday (Vixie cron): Friday 2026-11-20 comes before 2026-12-01.
    expect(iso(nextFire(cron("0 0 1 * 5"), at("2026-11-16T00:00:00Z")))).toBe("2026-11-20T00:00:00.000Z");
    // 7 is Sunday too.
    expect(iso(nextFire(cron("30 6 * * 7"), at("2026-11-16T00:00:00Z")))).toBe("2026-11-22T06:30:00.000Z");
    // February 29th, years ahead.
    expect(iso(nextFire(cron("0 12 29 2 *"), at("2026-11-16T00:00:00Z")))).toBe("2028-02-29T12:00:00.000Z");
  });
});

describe("checkSchedule", () => {
  it("refuses bad times, zones, days and cron fields", () => {
    expect(() => checkSchedule({ kind: "daily", time: "8:00", timeZone: "UTC" })).toThrow(/HH:MM/);
    expect(() => checkSchedule({ kind: "daily", time: "24:00", timeZone: "UTC" })).toThrow(/HH:MM/);
    expect(() => checkSchedule({ kind: "daily", time: "08:00", timeZone: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => checkSchedule({ kind: "weekly", day: 7, time: "08:00", timeZone: "UTC" })).toThrow(/day/);
    expect(() => checkSchedule({ kind: "cron", expression: "* * * *", timeZone: "UTC" })).toThrow(/five fields/);
    expect(() => checkSchedule({ kind: "cron", expression: "60 * * * *", timeZone: "UTC" })).toThrow(/minute/);
    expect(() => checkSchedule({ kind: "cron", expression: "0 0 31 2 *", timeZone: "UTC" })).toThrow(/never/);
    expect(() => checkSchedule({ kind: "cron", expression: "*/0 * * * *", timeZone: "UTC" })).toThrow(/step/);
    expect(() => checkSchedule({ kind: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Tokyo" })).not.toThrow();
  });
});
