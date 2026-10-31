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
  handshakeBytes: 0,
  accountBytesPerSecond: 0,
  accountBurstBytes: 0,
};

function lease(admission: ReturnType<ReturnType<typeof createRelayLimiter>["admit"]>): RelayLease {
  if (!admission.ok) throw new Error(`refused: ${admission.reason}`);
  return admission.lease;
}

/** An admitted lease whose handshake already completed, so charges hit the account budget. */
function authenticated(admission: ReturnType<ReturnType<typeof createRelayLimiter>["admit"]>): RelayLease {
  const admitted = lease(admission);
  admitted.authenticate();
  return admitted;
}

const overdrawn = { code: RELAY_CLOSE.trafficLimit };

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
    const first = authenticated(limiter.admit("h1", "a1"));
    const sibling = authenticated(limiter.admit("h2", "a1"));
    const stranger = authenticated(limiter.admit("h3", "a2"));
    expect(first.charge(600)).toBeUndefined();
    // The budget is per account: the sibling host draws from the same bucket.
    expect(sibling.charge(400)).toBeUndefined();
    expect(first.charge(1)).toMatchObject(overdrawn);
    // Another account is untouched.
    expect(stranger.charge(1000)).toBeUndefined();
    // While in debt, new connections for the account are refused up front.
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.trafficLimit });
    now = 1_000; // +100 bytes, which first repays the 1-byte overdraft
    expect(first.charge(99)).toBeUndefined();
    expect(first.charge(1)).toMatchObject(overdrawn);
    now = 20_000; // refill caps at the burst size
    expect(first.charge(1000)).toBeUndefined();
    expect(first.charge(1)).toMatchObject(overdrawn);
  });

  it("keeps an idle account's debt: reconnecting can't reset the budget", () => {
    let now = 0;
    const limiter = createRelayLimiter({ ...UNLIMITED, accountBytesPerSecond: 10, accountBurstBytes: 100 }, () => now);
    const only = authenticated(limiter.admit("h1", "a1"));
    expect(only.charge(150)).toMatchObject(overdrawn);
    only.release();
    expect(limiter.admit("h1", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.trafficLimit });
    now = 6_000;
    lease(limiter.admit("h1", "a1"));
  });

  it("charges an unauthenticated lease its own handshake allowance, never the account budget", () => {
    const limiter = createRelayLimiter({ ...UNLIMITED, handshakeBytes: 1000, accountBytesPerSecond: 1, accountBurstBytes: 100 }, () => 0);
    const pending = lease(limiter.admit("h1", "a1"));
    // Well past the account's 100-byte burst, yet within the allowance.
    expect(pending.charge(600)).toBeUndefined();
    expect(pending.charge(400)).toBeUndefined();
    expect(pending.charge(1)).toMatchObject({ code: RELAY_CLOSE.trafficLimit, reason: expect.stringMatching(/handshake/) });
    // The allowance is per connection, and the account budget is untouched.
    const other = lease(limiter.admit("h1", "a1"));
    expect(other.charge(1000)).toBeUndefined();
    other.authenticate();
    expect(other.charge(100)).toBeUndefined();
    expect(other.charge(1)).toMatchObject(overdrawn);
  });

  it("forgets a deleted account: a new account reusing its key starts fresh, and old leases can't touch it", () => {
    const limiter = createRelayLimiter({ ...UNLIMITED, perAccount: 1, accountBytesPerSecond: 1, accountBurstBytes: 100 }, () => 0);
    const old = authenticated(limiter.admit("h1", "a1"));
    expect(old.charge(150)).toMatchObject(overdrawn);
    limiter.forgetAccount("a1");
    const fresh = authenticated(limiter.admit("h2", "a1"));
    // The old lease still holding its slot doesn't count against the new account…
    expect(limiter.admit("h3", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.tooManyConnections });
    old.release();
    expect(limiter.admit("h3", "a1")).toMatchObject({ ok: false, code: RELAY_CLOSE.tooManyConnections });
    // …and its late traffic doesn't drain the new account's budget.
    old.charge(1000);
    expect(fresh.charge(100)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    const limiter = createRelayLimiter(UNLIMITED);
    for (let index = 0; index < 1000; index += 1) {
      const next = lease(limiter.admit("h1", "a1"));
      expect(next.charge(1024 * 1024)).toBeUndefined();
      next.authenticate();
      expect(next.charge(1024 * 1024)).toBeUndefined();
    }
  });

  it("reads limits from flags over env, with byte suffixes and seconds", () => {
    expect(
      readRelayLimits(
        { "relay-max-per-host": "8", "relay-account-burst": "512M", "relay-handshake-timeout": "15", "relay-handshake-bytes": "16k" },
        { PINOMAD_SERVER_RELAY_MAX_PER_HOST: "99", PINOMAD_SERVER_RELAY_ACCOUNT_RATE: "128k" },
      ),
    ).toEqual({
      perHost: 8,
      accountBurstBytes: 512 * 1024 * 1024,
      handshakeTimeoutMs: 15_000,
      handshakeBytes: 16 * 1024,
      accountBytesPerSecond: 128 * 1024,
    });
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
    // Room for IK message 1 with its hello and a pairing secret, many times over.
    expect(DEFAULT_RELAY_LIMITS.handshakeBytes).toBeGreaterThanOrEqual(16 * 1024);
  });
});
