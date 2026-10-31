import { describe, expect, it } from "vitest";
import { RELAY_CLOSE } from "@pinomad/protocol/relay.ts";
import {
  createRelayLimiter,
  DEFAULT_RELAY_LIMITS,
  readRelayLimits,
  type RelayLimits,
  type RelayLease,
} from "../src/relay-limits.ts";

const UNLIMITED: RelayLimits = {
  perHost: 0,
  perAccount: 0,
  unauthenticatedPerHost: 0,
  handshakeTimeoutMs: 0,
  accountBytesPerSecond: 0,
  accountBurstBytes: 0,
};

function lease(admission: ReturnType<ReturnType<typeof createRelayLimiter>["admit"]>): RelayLease {
  if (!admission.ok) throw new Error(`refused: ${admission.reason}`);
  return admission.lease;
}

describe("relay limiter", () => {
  it("caps concurrent connections per host and frees a slot on release", () => {
    const limiter = createRelayLimiter({ ...UNLIMITED, perHost: 2 });
    const first = lease(limiter.admit("h1", "a1"));
    lease(limiter.admit("h1", "a1"));
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.tooManyConnections });
    // Another host is counted separately.
    lease(limiter.admit("h2", "a1"));
    first.release();
    first.release(); // idempotent: must not free a second slot
    lease(limiter.admit("h1", "a1"));
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false });
  });

  it("caps concurrent connections per account across its hosts", () => {
    const limiter = createRelayLimiter({ ...UNLIMITED, perAccount: 2 });
    lease(limiter.admit("h1", "a1"));
    lease(limiter.admit("h2", "a1"));
    expect(limiter.admit("h3", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.tooManyConnections });
    lease(limiter.admit("h3", "a2"));
  });

  it("counts only unauthenticated connections against the smaller handshake cap", () => {
    const limiter = createRelayLimiter({ ...UNLIMITED, perHost: 3, unauthenticatedPerHost: 1 });
    const first = lease(limiter.admit("h1", "a1"));
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.tooManyConnections });
    first.authenticate();
    first.authenticate(); // idempotent
    const second = lease(limiter.admit("h1", "a1"));
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false });
    // Releasing an unauthenticated lease frees the handshake slot too.
    second.release();
    lease(limiter.admit("h1", "a1"));
  });

  it("drains an account's byte budget and refuses until it refills", () => {
    let now = 0;
    const limiter = createRelayLimiter({ ...UNLIMITED, accountBytesPerSecond: 100, accountBurstBytes: 1000 }, () => now);
    const first = lease(limiter.admit("h1", "a1"));
    const sibling = lease(limiter.admit("h2", "a1"));
    const stranger = lease(limiter.admit("h3", "a2"));
    expect(first.charge(600)).toBe(true);
    // The budget is per account: the sibling host draws from the same bucket.
    expect(sibling.charge(400)).toBe(true);
    expect(first.charge(1)).toBe(false);
    // Another account is untouched.
    expect(stranger.charge(1000)).toBe(true);
    // While in debt, new connections for the account are refused up front.
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.trafficLimit });
    now = 1_000; // +100 bytes, which first repays the 1-byte overdraft
    expect(first.charge(99)).toBe(true);
    expect(first.charge(1)).toBe(false);
    now = 20_000; // refill caps at the burst size
    expect(first.charge(1000)).toBe(true);
    expect(first.charge(1)).toBe(false);
  });

  it("forgets nothing it still needs: a released account keeps its debt", () => {
    let now = 0;
    const limiter = createRelayLimiter({ ...UNLIMITED, accountBytesPerSecond: 10, accountBurstBytes: 100 }, () => now);
    const only = lease(limiter.admit("h1", "a1"));
    expect(only.charge(150)).toBe(false);
    only.release();
    // Reconnecting can't reset the budget.
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.trafficLimit });
    now = 6_000;
    lease(limiter.admit("h1", "a1"));
  });

  it("treats 0 as unlimited", () => {
    const limiter = createRelayLimiter(UNLIMITED);
    for (let index = 0; index < 1000; index += 1) {
      const next = lease(limiter.admit("h1", "a1"));
      expect(next.charge(1024 * 1024)).toBe(true);
    }
  });

  it("reads limits from flags over env, with byte suffixes and seconds", () => {
    expect(
      readRelayLimits(
        { "relay-max-per-host": "8", "relay-account-burst": "512M", "relay-handshake-timeout": "15" },
        { PINOMAD_SERVER_RELAY_MAX_PER_HOST: "99", PINOMAD_SERVER_RELAY_ACCOUNT_RATE: "128k" },
      ),
    ).toEqual({ perHost: 8, accountBurstBytes: 512 * 1024 * 1024, handshakeTimeoutMs: 15_000, accountBytesPerSecond: 128 * 1024 });
    expect(readRelayLimits({}, {})).toEqual({});
    expect(readRelayLimits({ "relay-account-rate": "0" }, {})).toEqual({ accountBytesPerSecond: 0 });
  });

  it("rejects malformed limits instead of running without them", () => {
    expect(() => readRelayLimits({ "relay-max-per-host": "lots" }, {})).toThrow(/relay-max-per-host/);
    expect(() => readRelayLimits({ "relay-max-per-host": "4k" }, {})).toThrow();
    expect(() => readRelayLimits({}, { PINOMAD_SERVER_RELAY_ACCOUNT_RATE: "-1" })).toThrow(/RELAY_ACCOUNT_RATE/);
    expect(() => readRelayLimits({ "relay-handshake-timeout": "1.5" }, {})).toThrow();
  });

  it("ships loose self-host defaults that keep the host's own 16 pending accepts", () => {
    expect(DEFAULT_RELAY_LIMITS.unauthenticatedPerHost).toBeGreaterThanOrEqual(16);
    // A backstop behind the host's 10 s accept + 10 s handshake deadlines.
    expect(DEFAULT_RELAY_LIMITS.handshakeTimeoutMs).toBeGreaterThanOrEqual(20_000);
  });
});
