// The outbox's pacing (ADR-0052 §4): what goes out now, as one push or a
// digest, and when to look again. A pure function of the messages and the time.
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { OutboxMessage } from "../src/inbox.ts";
import { DEFAULT_POLICY, failedDelivery, plan, type DeliveryPolicy } from "../src/outbox-policy.ts";

const MIN = 60_000;
const T = Date.UTC(2026, 10, 16, 12, 0, 0);
const policy: DeliveryPolicy = { ...DEFAULT_POLICY, gatherMs: 30_000, maxWaitMs: 2 * MIN, perHour: 3 };

let seq = 0;
const message = (at: number, extra: Partial<OutboxMessage> = {}): OutboxMessage => ({
  id: `notify:${++seq}`,
  project: "/p",
  task: "t",
  conversationId: seq as ConversationId,
  text: "x",
  at,
  sent: false,
  ...extra,
});

describe("outbox plan", () => {
  it("waits for a short quiet spell, then sends what gathered as one push", () => {
    const a = message(T);
    const b = message(T + 10_000);
    expect(plan([a, b], T + 20_000, policy)).toEqual({ send: [], drop: [], wakeAt: T + 40_000 });
    expect(plan([a, b], T + 40_000, policy)).toEqual({ send: [a, b], drop: [] });
  });

  it("does not let a steady trickle hold the first message past the longest wait", () => {
    const first = message(T);
    const late = message(T + 2 * MIN - 1_000);
    expect(plan([first, late], T + 2 * MIN, policy).send).toEqual([first, late]);
  });

  it("holds pushes over the hourly cap until the oldest one in the hour ages out", () => {
    const sent = [0, 10, 20].map((m) => message(T - 50 * MIN + m * MIN, { sent: true, sentAt: T - 50 * MIN + m * MIN, pushId: `p${m}` }));
    const waiting = message(T - MIN);
    expect(plan([...sent, waiting], T, policy)).toEqual({ send: [], drop: [], wakeAt: T + 10 * MIN });
    // A digest counts as one push however many messages it carried.
    const digest = [message(T - 50 * MIN, { sent: true, sentAt: T - 50 * MIN, pushId: "d" }), message(T - 50 * MIN, { sent: true, sentAt: T - 50 * MIN, pushId: "d" })];
    expect(plan([...digest, waiting], T, policy).send).toEqual([waiting]);
  });

  it("holds everything during quiet hours and wakes when they end", () => {
    const local = new Date(T);
    const minute = local.getHours() * 60 + local.getMinutes();
    const quiet = { ...policy, quietHours: { start: (minute - 60 + 1440) % 1440, end: (minute + 30) % 1440 } };
    const m = message(T - MIN);
    expect(plan([m], T, quiet)).toEqual({ send: [], drop: [], wakeAt: T + 30 * MIN });
  });

  it("drops what is too old to be news and waits out a retry delay", () => {
    const old = message(T - policy.staleMs - 1);
    const retrying = message(T - 5 * MIN, { attempts: 1, retryAt: T + MIN });
    expect(plan([old, retrying], T, policy)).toEqual({ send: [], drop: [old.id], wakeAt: T + MIN });
  });

  it("backs off a failed delivery and gives up after the last attempt", () => {
    expect(failedDelivery(message(T), T)).toEqual({ attempts: 1, retryAt: T + MIN });
    expect(failedDelivery(message(T, { attempts: 3 }), T)).toEqual({ attempts: 4, retryAt: T + 8 * MIN });
    expect(failedDelivery(message(T, { attempts: 4 }), T)).toEqual({ attempts: 5, giveUp: true });
  });
});
