// Relay splice limits (issue #453): concurrent-connection caps per host and
// per account, a tighter cap on devices still in their handshake, and a
// per-account byte budget. Pure bookkeeping with an injected clock — the relay
// owns the sockets and timers and asks this module whether to let one in.

import { RELAY_CLOSE } from "@pinomad/protocol/relay.ts";

/** Every knob; 0 turns that limit off. */
export interface RelayLimits {
  /** Concurrent device connections (pending or spliced) per host. */
  readonly perHost: number;
  /** The same, summed over every host bound to one account. */
  readonly perAccount: number;
  /** Device connections per host whose handshake hasn't completed yet. */
  readonly unauthenticatedPerHost: number;
  /** How long a device may stay unauthenticated, from connect, before the relay closes it. */
  readonly handshakeTimeoutMs: number;
  /** Sustained relay traffic per account, both directions summed. */
  readonly accountBytesPerSecond: number;
  /** Traffic an account may spend at once before the sustained rate applies. */
  readonly accountBurstBytes: number;
}

/**
 * Loose enough that a self-hosted server never notices them. The host itself
 * takes up to 16 pending accepts and gives each 10 s to accept plus 10 s to
 * finish the handshake, so the handshake cap and deadline sit above those.
 * 1 GiB of burst refilled at 4 MiB/s is about 340 GiB a day per account.
 */
export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  perHost: 64,
  perAccount: 256,
  unauthenticatedPerHost: 32,
  handshakeTimeoutMs: 30_000,
  accountBytesPerSecond: 4 * 1024 * 1024,
  accountBurstBytes: 1024 * 1024 * 1024,
};

/** The `pinomad server` flag, its env fallback, and how its text maps to a RelayLimits field. */
export const RELAY_LIMIT_OPTIONS = [
  { field: "perHost", flag: "relay-max-per-host", env: "PINOMAD_SERVER_RELAY_MAX_PER_HOST", unit: "count" },
  { field: "perAccount", flag: "relay-max-per-account", env: "PINOMAD_SERVER_RELAY_MAX_PER_ACCOUNT", unit: "count" },
  {
    field: "unauthenticatedPerHost",
    flag: "relay-max-unauthenticated-per-host",
    env: "PINOMAD_SERVER_RELAY_MAX_UNAUTHENTICATED_PER_HOST",
    unit: "count",
  },
  { field: "handshakeTimeoutMs", flag: "relay-handshake-timeout", env: "PINOMAD_SERVER_RELAY_HANDSHAKE_TIMEOUT", unit: "seconds" },
  { field: "accountBytesPerSecond", flag: "relay-account-rate", env: "PINOMAD_SERVER_RELAY_ACCOUNT_RATE", unit: "bytes" },
  { field: "accountBurstBytes", flag: "relay-account-burst", env: "PINOMAD_SERVER_RELAY_ACCOUNT_BURST", unit: "bytes" },
] as const satisfies readonly { field: keyof RelayLimits; flag: string; env: string; unit: "count" | "seconds" | "bytes" }[];

const BYTE_SUFFIX: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/**
 * Reads the limits a flag or env var sets (flag wins); unset ones stay out so
 * the defaults apply. Counts are whole numbers, the timeout is seconds, byte
 * sizes take an optional binary k/m/g suffix ("4m" = 4 MiB). Throws on
 * anything else rather than silently running with no limit.
 */
export function readRelayLimits(
  flags: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): Partial<RelayLimits> {
  const limits: Partial<Record<keyof RelayLimits, number>> = {};
  for (const option of RELAY_LIMIT_OPTIONS) {
    const flag = flags[option.flag];
    const raw = typeof flag === "string" ? flag : env[option.env];
    if (raw === undefined) continue;
    const match = /^(\d+)([kmg]?)$/i.exec(raw.trim());
    const suffix = match?.[2]?.toLowerCase() ?? "";
    if (match === null || (option.unit !== "bytes" && suffix !== "")) {
      throw new Error(`--${option.flag} (${option.env}) must be a whole number${option.unit === "bytes" ? " with an optional k/m/g suffix" : ""}, got "${raw}"`);
    }
    const value = Number(match[1]) * BYTE_SUFFIX[suffix]!;
    limits[option.field] = option.unit === "seconds" ? value * 1000 : value;
  }
  return limits;
}

/** One admitted device connection's share of the counters. */
export interface RelayLease {
  /** The handshake completed: stop counting against the unauthenticated cap. Idempotent. */
  authenticate(): void;
  /** Spend `bytes` of the account's budget; false once the budget is overdrawn. */
  charge(bytes: number): boolean;
  /** Give the slot back. Idempotent. */
  release(): void;
}

export type RelayAdmission =
  | { readonly ok: true; readonly lease: RelayLease }
  | { readonly ok: false; readonly code: number; readonly reason: string };

export interface RelayLimiter {
  /** `account` keys the per-account caps and budget; any stable string per account. */
  admit(hostId: string, account: string): RelayAdmission;
}

interface Bucket {
  /** May go negative: the frame that overdraws is charged, so the debt is repaid before new traffic. */
  tokens: number;
  updatedAt: number;
}

export function createRelayLimiter(limits: RelayLimits, now: () => number = Date.now): RelayLimiter {
  const hostCount = new Map<string, number>();
  const hostUnauthenticated = new Map<string, number>();
  const accountCount = new Map<string, number>();
  const buckets = new Map<string, Bucket>();
  const rate = limits.accountBytesPerSecond;
  const capacity = limits.accountBurstBytes > 0 ? limits.accountBurstBytes : rate;

  const over = (cap: number, count: number | undefined): boolean => cap > 0 && (count ?? 0) >= cap;
  const bump = (counts: Map<string, number>, key: string, delta: number): void => {
    const next = (counts.get(key) ?? 0) + delta;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  };

  /** The account's bucket, refilled up to now; undefined when the budget is off. */
  function bucket(account: string): Bucket | undefined {
    if (rate <= 0) return undefined;
    const at = now();
    const existing = buckets.get(account);
    if (existing === undefined) {
      const fresh = { tokens: capacity, updatedAt: at };
      buckets.set(account, fresh);
      return fresh;
    }
    existing.tokens = Math.min(capacity, existing.tokens + ((at - existing.updatedAt) / 1000) * rate);
    existing.updatedAt = at;
    return existing;
  }

  return {
    admit(hostId, account) {
      const budget = bucket(account);
      if (budget !== undefined && budget.tokens < 0) {
        return { ok: false, code: RELAY_CLOSE.trafficLimit, reason: "account traffic limit" };
      }
      if (over(limits.perHost, hostCount.get(hostId))) {
        return { ok: false, code: RELAY_CLOSE.tooManyConnections, reason: "too many connections to this host" };
      }
      if (over(limits.perAccount, accountCount.get(account))) {
        return { ok: false, code: RELAY_CLOSE.tooManyConnections, reason: "too many connections for this account" };
      }
      if (over(limits.unauthenticatedPerHost, hostUnauthenticated.get(hostId))) {
        return { ok: false, code: RELAY_CLOSE.tooManyConnections, reason: "too many pending handshakes for this host" };
      }
      bump(hostCount, hostId, 1);
      bump(accountCount, account, 1);
      bump(hostUnauthenticated, hostId, 1);
      let authenticated = false;
      let released = false;
      return {
        ok: true,
        lease: {
          authenticate() {
            if (authenticated || released) return;
            authenticated = true;
            bump(hostUnauthenticated, hostId, -1);
          },
          charge(bytes) {
            const current = bucket(account);
            if (current === undefined) return true;
            current.tokens -= bytes;
            return current.tokens >= 0;
          },
          release() {
            if (released) return;
            released = true;
            bump(hostCount, hostId, -1);
            bump(accountCount, account, -1);
            if (!authenticated) bump(hostUnauthenticated, hostId, -1);
            // A full bucket carries no state worth keeping once the account is
            // idle; one still in debt stays so reconnecting can't reset it.
            if (!accountCount.has(account)) {
              const left = bucket(account);
              if (left !== undefined && left.tokens >= capacity) buckets.delete(account);
            }
          },
        },
      };
    },
  };
}
