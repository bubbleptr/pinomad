// The outbox's pacing (ADR-0052 §4): pushes for `notify` messages go out
// after a short quiet spell, so several close together become one digest;
// at most `perHour` pushes an hour; none during quiet hours; a failed
// delivery is retried with backoff. Pure: the sender asks, sends and stores.
import type { OutboxMessage, OutboxPush } from "./inbox.ts";

export type DeliveryPolicy = {
  /** Pushes an hour at most; a digest counts as one. */
  readonly perHour: number;
  /** A push waits until no new message arrived for this long… */
  readonly gatherMs: number;
  /** …but never holds its oldest message longer than this. */
  readonly maxWaitMs: number;
  /** An unsent message older than this is not news any more: dropped without a push. */
  readonly staleMs: number;
  /** Local minutes of the day, `start` inclusive; may wrap past midnight. */
  readonly quietHours?: { readonly start: number; readonly end: number };
};

export const DEFAULT_POLICY: DeliveryPolicy = {
  perHour: 6,
  gatherMs: 30_000,
  maxWaitMs: 2 * 60_000,
  staleMs: 12 * 60 * 60_000,
};

const HOUR = 60 * 60_000;
const RETRY_BASE_MS = 60_000;
const MAX_ATTEMPTS = 5;

/** Minutes after local midnight. */
const minuteOfDay = (at: number): number => {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
};

/** When the quiet hours `at` falls in end, or undefined outside them. */
function quietUntil(at: number, quiet: DeliveryPolicy["quietHours"]): number | undefined {
  if (quiet === undefined || quiet.start === quiet.end) return undefined;
  const minute = minuteOfDay(at);
  const inside = quiet.start < quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end;
  if (!inside) return undefined;
  const ahead = (quiet.end - minute + 1440) % 1440;
  const date = new Date(at);
  date.setSeconds(0, 0);
  return date.getTime() + ahead * 60_000;
}

/**
 * What to do now: `send` the messages that go out together (one push, or a
 * digest when several), `drop` the stale ones, and look again at `wakeAt`.
 */
export function plan(
  messages: readonly Readonly<OutboxMessage>[],
  pushes: readonly Readonly<OutboxPush>[],
  now: number,
  policy: DeliveryPolicy,
): { send: Readonly<OutboxMessage>[]; drop: string[]; wakeAt?: number } {
  const unsent = messages.filter((message) => !message.sent);
  const drop = unsent.filter((message) => now - message.at > policy.staleMs).map((message) => message.id);
  const live = unsent.filter((message) => !drop.includes(message.id));
  const ready = live.filter((message) => (message.retryAt ?? 0) <= now);
  const later = live.filter((message) => (message.retryAt ?? 0) > now).map((message) => message.retryAt!);
  const wakes: number[] = [...later];
  const done = (send: Readonly<OutboxMessage>[] = []) => {
    const wakeAt = wakes.length === 0 ? undefined : Math.min(...wakes);
    return { send, drop, ...(wakeAt === undefined ? {} : { wakeAt }) };
  };
  if (ready.length === 0) return done();

  const quiet = quietUntil(now, policy.quietHours);
  if (quiet !== undefined) {
    wakes.push(quiet);
    return done();
  }

  const newest = Math.max(...ready.map((message) => message.at));
  const oldest = Math.min(...ready.map((message) => message.at));
  if (now - newest < policy.gatherMs && now - oldest < policy.maxWaitMs) {
    wakes.push(Math.min(newest + policy.gatherMs, oldest + policy.maxWaitMs));
    return done();
  }

  // The pushes sent in the last hour, a digest once, counted from when each went out.
  const recent = pushes.filter((push) => now - push.at < HOUR).map((push) => push.at).sort((a, b) => a - b);
  if (recent.length >= policy.perHour) {
    wakes.push(recent[recent.length - policy.perHour]! + HOUR);
    return done();
  }
  return done(ready);
}

/** The next attempt after a delivery that reached no device, or giving up after the last. */
export function failedDelivery(
  message: Readonly<OutboxMessage>,
  now: number,
): { attempts: number; retryAt: number } | { attempts: number; giveUp: true } {
  const attempts = (message.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) return { attempts, giveUp: true };
  return { attempts, retryAt: now + RETRY_BASE_MS * 2 ** (attempts - 1) };
}
