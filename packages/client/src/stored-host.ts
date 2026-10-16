// A stored host entry every client persists in its own medium (browser
// localStorage, iOS keychain, desktop's encrypted file). Validation lives
// here so all three reject the same shapes: only ws/wss urls, and keys that
// are base64url of exactly 32 bytes.
import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";

/**
 * The account linkage of a paired host (ADR-0022): which server bound the
 * host and under what hostId. Absent on entries paired before accounts
 * existed or through QR links — they still work, they just can't be matched
 * back to a `GET /api/hosts` row except by Noise key.
 */
export interface StoredHostAccount {
  readonly serverOrigin: string;
  readonly hostId: string;
}

/** One paired host: where to dial and this device's identity on it (base64url, 32 bytes each). */
export type StoredHost = { url: string; hostKey: string; privateKey: string; account?: StoredHostAccount };

const isKey = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return fromBase64Url(value).length === 32;
  } catch {
    return false;
  }
};

const isHostUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
};

/** hostId is the host's relay identity — base64url of a 32-byte key, like hostKey. */
const isAccountLink = (value: unknown): value is StoredHostAccount => {
  if (typeof value !== "object" || value === null) return false;
  const account = value as Record<string, unknown>;
  return typeof account.serverOrigin === "string" && account.serverOrigin !== "" && isKey(account.hostId);
};

/** A validated stored host, or undefined. The result holds only the four fields. */
export function parseStoredHost(value: unknown): StoredHost | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const host = value as Record<string, unknown>;
  if (!isHostUrl(host.url) || !isKey(host.hostKey) || !isKey(host.privateKey)) return undefined;
  // A malformed account link costs the association, not the pairing: the
  // stored key still connects the device.
  const account = isAccountLink(host.account) ? host.account : undefined;
  return {
    url: host.url,
    hostKey: host.hostKey,
    privateKey: host.privateKey,
    ...(account === undefined ? {} : { account }),
  };
}

/**
 * Sidebar/menu label per host: the URL's host, disambiguated by the hostKey
 * prefix when two hosts share one (e.g. two hosts behind the same relay).
 */
export function hostLabels(hosts: readonly StoredHost[]): Map<string, string> {
  const base = (host: StoredHost): string => {
    try {
      return new URL(host.url).host;
    } catch {
      return host.url;
    }
  };
  const counts = new Map<string, number>();
  for (const host of hosts) counts.set(base(host), (counts.get(base(host)) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const host of hosts) {
    const label = base(host);
    labels.set(host.hostKey, counts.get(label)! > 1 ? `${label} · ${host.hostKey.slice(0, 6)}` : label);
  }
  return labels;
}
