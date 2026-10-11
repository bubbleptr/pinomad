// A stored host entry every client persists in its own medium (browser
// localStorage, iOS keychain, desktop's encrypted file). Validation lives
// here so all three reject the same shapes: only ws/wss urls, and keys that
// are base64url of exactly 32 bytes.
import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";

/** One paired host: where to dial and this device's identity on it (base64url, 32 bytes each). */
export type StoredHost = { url: string; hostKey: string; privateKey: string };

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

/** A validated stored host, or undefined. The result holds only the three fields. */
export function parseStoredHost(value: unknown): StoredHost | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const host = value as Record<string, unknown>;
  if (!isHostUrl(host.url) || !isKey(host.hostKey) || !isKey(host.privateKey)) return undefined;
  return { url: host.url, hostKey: host.hostKey, privateKey: host.privateKey };
}
