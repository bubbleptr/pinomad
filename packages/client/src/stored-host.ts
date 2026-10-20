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
export type StoredHost = {
  url: string;
  hostKey: string;
  privateKey: string;
  /** The machine's display name, cached from the host's settings (5.12); absent until a 5.12 host announces it. */
  name?: string;
  account?: StoredHostAccount;
};

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

/** A validated stored host, or undefined. The result holds only the five fields. */
export function parseStoredHost(value: unknown): StoredHost | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const host = value as Record<string, unknown>;
  if (!isHostUrl(host.url) || !isKey(host.hostKey) || !isKey(host.privateKey)) return undefined;
  // A malformed account link costs the association, not the pairing: the
  // stored key still connects the device. Same for the name — a wrong shape
  // or an empty one is no name, the URL host labels it then.
  const account = isAccountLink(host.account) ? host.account : undefined;
  const name = typeof host.name === "string" && host.name !== "" ? host.name : undefined;
  return {
    url: host.url,
    hostKey: host.hostKey,
    privateKey: host.privateKey,
    ...(name === undefined ? {} : { name }),
    ...(account === undefined ? {} : { account }),
  };
}

/**
 * Sidebar/menu label per host (5.12): the stored machine name when the host
 * announced one, else the URL's host. Labels must end up unique, so a base
 * shared by several hosts gains its hostKey prefix — six UTF-16 units first,
 * lengthened while a collision remains (a stored name can shadow another
 * host's disambiguated label).
 */
export function hostLabels(hosts: readonly StoredHost[]): Map<string, string> {
  const base = (host: StoredHost): string => {
    if (host.name !== undefined) return host.name;
    try {
      return new URL(host.url).host;
    } catch {
      return host.url;
    }
  };
  const bases = hosts.map(base);
  // The hostKey prefix length per entry — 0 keeps the plain base.
  const suffix = hosts.map(() => 0);
  const counts = new Map<string, number>();
  for (const label of bases) counts.set(label, (counts.get(label) ?? 0) + 1);
  bases.forEach((label, i) => {
    if (counts.get(label)! > 1) suffix[i] = 6;
  });
  const label = (i: number): string =>
    suffix[i] === 0 ? bases[i]! : `${bases[i]} · ${hosts[i]!.hostKey.slice(0, suffix[i])}`;
  // Lengthen colliding suffixes until no two labels match. Only a suffixed
  // label can grow — a plain base is the host's literal label. Distinct
  // hostKeys diverge inside 43 units, so this converges; the `grew` guard
  // bounds the pathological case (two entries sharing base and key).
  for (;;) {
    const seen = new Map<string, number>();
    const collided = new Set<number>();
    hosts.forEach((_, i) => {
      const other = seen.get(label(i));
      if (other === undefined) seen.set(label(i), i);
      else {
        collided.add(other);
        collided.add(i);
      }
    });
    if (collided.size === 0) break;
    let grew = false;
    for (const i of collided) {
      if (suffix[i]! > 0 && suffix[i]! < hosts[i]!.hostKey.length) {
        suffix[i]! += 1;
        grew = true;
      }
    }
    if (!grew) break;
  }
  const labels = new Map<string, string>();
  hosts.forEach((host, i) => labels.set(host.hostKey, label(i)));
  return labels;
}
