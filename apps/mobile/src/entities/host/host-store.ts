import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";

/** One paired host and this device's identity on it; keys are base64url, 32 bytes. */
export type StoredHost = { url: string; hostKey: string; privateKey: string };

/** Where paired hosts live; the device keeps every host it has paired. */
export interface HostStore {
  readonly multiHost: true;
  list(): Promise<StoredHost[]>;
  /** Upserts by hostKey. */
  save(host: StoredHost): Promise<void>;
  remove(hostKey: string): Promise<void>;
}

/** The async key/value pair expo-secure-store provides; injected for tests. */
export interface KeyValueStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync?(key: string): Promise<void>;
}

/** Secure-store key holding the JSON array of paired hosts. */
export const HOSTS_KEY = "pinomad.hosts";

/** A validated stored host entry, or undefined — same rule as the web client's storedDevice. */
function storedHost(value: unknown): StoredHost | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { url, hostKey, privateKey } = value as { url?: unknown; hostKey?: unknown; privateKey?: unknown };
  if (typeof url !== "string" || typeof hostKey !== "string" || typeof privateKey !== "string") return undefined;
  try {
    if (fromBase64Url(hostKey).length !== 32 || fromBase64Url(privateKey).length !== 32) return undefined;
  } catch {
    return undefined;
  }
  return { url, hostKey, privateKey };
}

/**
 * Paired hosts in an async key/value store (expo-secure-store on device).
 * Bad entries — malformed JSON, wrong field types, keys that aren't 32 bytes —
 * are dropped on read without losing the valid ones. A storage read that
 * *throws* surfaces to list() as [] but propagates out of save()/remove(): a
 * failed read must never turn into a write that wipes the stored list.
 */
export function createHostStore(storage: KeyValueStorage): HostStore {
  const read = async (): Promise<StoredHost[]> => {
    const raw = await storage.getItemAsync(HOSTS_KEY);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const host = storedHost(entry);
      return host === undefined ? [] : [host];
    });
  };
  return {
    multiHost: true,
    list: () => read().catch(() => []),
    save: async (host) => {
      const hosts = await read();
      await storage.setItemAsync(HOSTS_KEY, JSON.stringify([...hosts.filter((each) => each.hostKey !== host.hostKey), host]));
    },
    remove: async (hostKey) => {
      const next = (await read()).filter((each) => each.hostKey !== hostKey);
      if (next.length === 0 && storage.deleteItemAsync !== undefined) {
        await storage.deleteItemAsync(HOSTS_KEY);
        return;
      }
      await storage.setItemAsync(HOSTS_KEY, JSON.stringify(next));
    },
  };
}
