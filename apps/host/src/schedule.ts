// When a schedule source fires (ADR-0051 §10): daily, weekdays, weekly or a
// five-field cron expression, each read as wall time in an IANA time zone.
// A wall time the spring-forward gap skips fires once, at the end of the gap;
// one the fall-back repeats fires once, at its first occurrence.
import type { InboxSchedule } from "@pinomad/protocol/inbox.ts";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** How far ahead a cron expression may next match: Feb 29 on a given weekday can be decades away, and nobody waits that long. */
const SEARCH_DAYS = 366 * 8;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type Field = ReadonlySet<number>;
type Cron = {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: Field;
  readonly months: Field;
  readonly weekdays: Field;
  /** Both day fields were restricted: either one matching is enough (Vixie cron). */
  readonly eitherDay: boolean;
};

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseField(text: string, { name, min, max }: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  const number = (part: string): number => {
    if (!/^\d+$/.test(part)) throw new Error(`The cron ${name} field has ${JSON.stringify(part)}, not a number`);
    const value = Number(part);
    if (value < min || value > max) throw new Error(`The cron ${name} field goes from ${min} to ${max}, not ${value}`);
    return value;
  };
  for (const item of text.split(",")) {
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined) throw new Error(`The cron ${name} field has ${JSON.stringify(item)}`);
    const step = stepText === undefined ? 1 : number(stepText);
    if (step === 0) throw new Error(`The cron ${name} field has a step of 0`);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [min, max];
    else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      [from, to] = [number(a), number(b)];
      if (from > to) throw new Error(`The cron ${name} field's range ${range} runs backwards`);
    } else {
      from = number(range);
      to = stepText === undefined ? from : max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A cron expression has five fields: minute hour day-of-month month day-of-week");
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]!));
  if (weekdays!.delete(7)) weekdays!.add(0);
  return {
    minutes: [...minutes!].sort((a, b) => a - b),
    hours: [...hours!].sort((a, b) => a - b),
    days: days!,
    months: months!,
    weekdays: weekdays!,
    eitherDay: !parts[2]!.startsWith("*") && !parts[4]!.startsWith("*"),
  };
}

function cronOf(schedule: InboxSchedule): Cron {
  if (schedule.kind === "cron") return parseCron(schedule.expression);
  const match = TIME.exec(schedule.time);
  if (match === null) throw new Error(`The time must be HH:MM (24-hour), not ${JSON.stringify(schedule.time)}`);
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  const day = schedule.kind === "daily" ? "*" : schedule.kind === "weekdays" ? "1-5" : String(schedule.day);
  if (schedule.kind === "weekly" && !(Number.isInteger(schedule.day) && schedule.day >= 0 && schedule.day <= 6)) {
    throw new Error(`The day must be 0 (Sunday) to 6, not ${schedule.day}`);
  }
  return parseCron(`${minute} ${hour} * * ${day}`);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
    } catch {
      throw new Error(`Unknown time zone ${JSON.stringify(timeZone)}`);
    }
    formatters.set(timeZone, format);
  }
  return format;
}

/** The zone's wall time at `instant`, as if that wall time were UTC (minute precision). */
function wall(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}

/**
 * The first instant whose wall time in `timeZone` is `local` (a wall time
 * written as UTC ms); in a spring-forward gap, the first instant after it.
 */
function resolve(local: number, timeZone: string): number {
  // Every offset the zone has around that day; a candidate is right when it reads back as `local`.
  const offsets = new Set([local - DAY_MS, local, local + DAY_MS].map((guess) => wall(guess, timeZone) - guess));
  const candidates = [...offsets].map((offset) => local - offset).sort((a, b) => a - b);
  const exact = candidates.find((candidate) => wall(candidate, timeZone) === local);
  if (exact !== undefined) return exact;
  // In the gap: the earliest minute whose wall time is past `local`.
  let low = candidates[0]!;
  let high = candidates.at(-1)!;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (wall(middle, timeZone) >= local) high = middle;
    else low = middle;
  }
  return high;
}

function dayMatches(cron: Cron, day: Date): boolean {
  if (!cron.months.has(day.getUTCMonth() + 1)) return false;
  const ofMonth = cron.days.has(day.getUTCDate());
  const ofWeek = cron.weekdays.has(day.getUTCDay());
  return cron.eitherDay ? ofMonth || ofWeek : ofMonth && ofWeek;
}

function nextOf(cron: Cron, timeZone: string, after: number): number | undefined {
  const now = wall(after, timeZone);
  const today = now - (now % DAY_MS);
  for (let index = 0; index < SEARCH_DAYS; index++) {
    const day = today + index * DAY_MS;
    if (!dayMatches(cron, new Date(day))) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const local = day + hour * 3_600_000 + minute * MINUTE_MS;
        // Wall times well before now cannot resolve after it; offsets differ by hours at most.
        if (local < now - DAY_MS / 2) continue;
        const instant = resolve(local, timeZone);
        if (instant > after) return instant;
      }
    }
  }
  return undefined;
}

/** Throws a readable reason when `schedule` is malformed or never fires. */
export function checkSchedule(schedule: InboxSchedule): void {
  formatter(schedule.timeZone);
  if (nextOf(cronOf(schedule), schedule.timeZone, Date.now()) === undefined) throw new Error("This schedule never fires");
}

/** The first fire strictly after `after` (epoch ms). Throws for a schedule `checkSchedule` refuses. */
export function nextFire(schedule: InboxSchedule, after: number): number {
  const next = nextOf(cronOf(schedule), schedule.timeZone, after);
  if (next === undefined) throw new Error("This schedule never fires");
  return next;
}
