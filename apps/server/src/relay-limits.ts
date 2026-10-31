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
  /**
   * Bytes one device may send before its handshake completes. They never
   * touch the account budget (a stranger who knows the hostId could drain
   * it), so this per-connection allowance is what bounds them.
   */
  readonly handshakeBytes: number;
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
  // IK message 1 with its hello and a pairing secret is well under 1 KiB.
  handshakeBytes: 64 * 1024,
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
  { field: "handshakeBytes", flag: "relay-handshake-bytes", env: "PINOMAD_SERVER_RELAY_HANDSHAKE_BYTES", unit: "bytes" },
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

/** Why the relay refuses or closes a device connection. */
export interface RelayRefusal {
  readonly code: number;
  readonly reason: string;
}

/** One admitted device connection's share of the counters. */
export interface RelayLease {
  /** The handshake completed: stop counting against the unauthenticated cap. Idempotent. */
  authenticate(): void;
  /**
   * Spend `bytes`: before authenticate() from this connection's handshake
   * allowance, after it from the account's budget. A refusal means close.
   */
  charge(bytes: number): RelayRefusal | undefined;
  /** Give the slot back. Idempotent. */
  release(): void;
}

export type RelayAdmission = ({ readonly ok: true; readonly lease: RelayLease }) | ({ readonly ok: false } & RelayRefusal);

export interface RelayLimiter {
  /** `account` keys the per-account caps and budget; any stable string per account. */
  admit(hostId: string, account: string): RelayAdmission;
  /**
   * The account is gone: drop its counters and budget, so a new account that
   * reuses the key (users.id is reusable) starts fresh. Leases still open
   * under it keep a detached copy and can no longer affect the new one.
   */
  forgetAccount(account: string): void;
}

interface HostState {
  connections: number;
  unauthenticated: number;
}

interface AccountState {
  connections: number;
  /** May go negative: the frame that overdraws is charged, so the debt is repaid before new traffic. */
  tokens: number;
  updatedAt: number;
}

const TRAFFIC_LIMIT: RelayRefusal = { code: RELAY_CLOSE.trafficLimit, reason: "account traffic limit" };
const HANDSHAKE_TRAFFIC: RelayRefusal = { code: RELAY_CLOSE.trafficLimit, reason: "too much data before the handshake" };

export function createRelayLimiter(limits: RelayLimits, now: () => number = Date.now): RelayLimiter {
  // A lease holds its host's and account's state objects, not their keys:
  // releasing or charging after forgetAccount touches only the detached copy.
  const hosts = new Map<string, HostState>();
  const accounts = new Map<string, AccountState>();
  const rate = limits.accountBytesPerSecond;
  const capacity = limits.accountBurstBytes > 0 ? limits.accountBurstBytes : rate;

  const over = (cap: number, count: number): boolean => cap > 0 && count >= cap;

  /** Brings the account's tokens up to now. */
  function refill(state: AccountState): void {
    const at = now();
    state.tokens = Math.min(capacity, state.tokens + ((at - state.updatedAt) / 1000) * rate);
    state.updatedAt = at;
  }

  return {
    admit(hostId, account) {
      const host = hosts.get(hostId) ?? { connections: 0, unauthenticated: 0 };
      const owner = accounts.get(account) ?? { connections: 0, tokens: capacity, updatedAt: now() };
      if (rate > 0) {
        refill(owner);
        if (owner.tokens < 0) return { ok: false, ...TRAFFIC_LIMIT };
      }
      if (over(limits.perHost, host.connections)) {
        return { ok: false, code: RELAY_CLOSE.tooManyConnections, reason: "too many connections to this host" };
      }
      if (over(limits.perAccount, owner.connections)) {
        return { ok: false, code: RELAY_CLOSE.tooManyConnections, reason: "too many connections for this account" };
      }
      if (over(limits.unauthenticatedPerHost, host.unauthenticated)) {
        return { ok: false, code: RELAY_CLOSE.tooManyConnections, reason: "too many pending handshakes for this host" };
      }
      hosts.set(hostId, host);
      accounts.set(account, owner);
      host.connections += 1;
      host.unauthenticated += 1;
      owner.connections += 1;
      let authenticated = false;
      let released = false;
      let handshakeBytes = 0;
      return {
        ok: true,
        lease: {
          authenticate() {
            if (authenticated || released) return;
            authenticated = true;
            host.unauthenticated -= 1;
          },
          charge(bytes) {
            if (!authenticated) {
              handshakeBytes += bytes;
              return limits.handshakeBytes > 0 && handshakeBytes > limits.handshakeBytes ? HANDSHAKE_TRAFFIC : undefined;
            }
            if (rate <= 0) return undefined;
            refill(owner);
            owner.tokens -= bytes;
            return owner.tokens < 0 ? TRAFFIC_LIMIT : undefined;
          },
          release() {
            if (released) return;
            released = true;
            host.connections -= 1;
            if (!authenticated) host.unauthenticated -= 1;
            owner.connections -= 1;
            if (host.connections === 0 && hosts.get(hostId) === host) hosts.delete(hostId);
            // An idle account with a full bucket carries nothing worth keeping;
            // one still in debt stays, so reconnecting can't reset it.
            if (owner.connections === 0 && accounts.get(account) === owner) {
              if (rate > 0) refill(owner);
              if (rate <= 0 || owner.tokens >= capacity) accounts.delete(account);
            }
          },
        },
      };
    },
    forgetAccount(account) {
      accounts.delete(account);
    },
  };
}
