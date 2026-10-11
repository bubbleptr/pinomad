import { parseStoredHost, type StoredHost } from "@pinomad/client/stored-host.ts";

export type { StoredHost };

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

/**
 * Paired hosts in an async key/value store (expo-secure-store on device).
 * Bad entries — malformed JSON, wrong field types, keys that aren't 32 bytes —
 * are dropped on read without losing the valid ones. A storage read that
 * *throws* surfaces to list() as [] but propagates out of save()/remove(): a
 * failed read must never turn into a write that wipes the stored list.
 */
export function createHostStore(storage: KeyValueStorage): HostStore {
  // Keychain calls are async; serialize read-modify-write so concurrent saves
  // can't drop one (same pattern as the desktop host store). A rejected op
  // still lets the queue continue.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

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
      const host = parseStoredHost(entry);
      return host === undefined ? [] : [host];
    });
  };
  return {
    multiHost: true,
    list: () => enqueue(read).catch(() => []),
    save: (host) =>
      enqueue(async () => {
        const hosts = await read();
        await storage.setItemAsync(
          HOSTS_KEY,
          JSON.stringify([...hosts.filter((each) => each.hostKey !== host.hostKey), host]),
        );
      }),
    remove: (hostKey) =>
      enqueue(async () => {
        const next = (await read()).filter((each) => each.hostKey !== hostKey);
        if (next.length === 0 && storage.deleteItemAsync !== undefined) {
          await storage.deleteItemAsync(HOSTS_KEY);
          return;
        }
        await storage.setItemAsync(HOSTS_KEY, JSON.stringify(next));
      }),
  };
}
