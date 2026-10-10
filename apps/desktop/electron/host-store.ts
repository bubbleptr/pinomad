// The desktop's paired-host list: one encrypted blob in userData, written
// atomically. Pure file/cipher logic so vitest covers it without Electron —
// main.ts only supplies safeStorage and the userData path.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";

/** One paired host: where to dial and this device's identity on it (base64url, 32 bytes each). */
export type StoredHost = { readonly url: string; readonly hostKey: string; readonly privateKey: string };

/** The encryption seam main.ts fills with safeStorage — injectable so tests need no keychain. */
export type Cipher = {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
};

export interface HostStore {
  list(): Promise<StoredHost[]>;
  /** Upsert by hostKey: re-pairing the same host refreshes url/privateKey in place. */
  save(host: StoredHost): Promise<void>;
  remove(hostKey: string): Promise<void>;
}

const FILE = "hosts.bin";

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

// The payload crosses IPC — main must not trust the renderer's shape.
const isStoredHost = (value: unknown): value is StoredHost => {
  if (typeof value !== "object" || value === null) return false;
  const host = value as Record<string, unknown>;
  return isHostUrl(host.url) && isKey(host.hostKey) && isKey(host.privateKey);
};

export function createHostStore(dir: string, cipher: Cipher): HostStore {
  const file = join(dir, FILE);
  // IPC calls are async; serialize read-modify-write so concurrent saves can't drop one.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const readAll = async (): Promise<StoredHost[]> => {
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cipher.decrypt(data));
    } catch {
      // Never delete: move the blob aside so the next save can start over
      // without losing whatever it was.
      await rename(file, `${file}.unreadable`).catch(() => {});
      console.error(`pinomad: ${FILE} could not be decrypted — moved aside to ${FILE}.unreadable`);
      return [];
    }
    const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
    if (!Array.isArray(hosts)) return [];
    return hosts.filter(isStoredHost);
  };

  const writeAll = async (hosts: StoredHost[]): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, cipher.encrypt(JSON.stringify({ version: 1, hosts })));
    await rename(tmp, file);
  };

  return {
    list: () => enqueue(readAll),
    save: (host) =>
      enqueue(async () => {
        if (!isStoredHost(host)) throw new Error("invalid host payload");
        const hosts = await readAll();
        const index = hosts.findIndex((each) => each.hostKey === host.hostKey);
        if (index === -1) hosts.push(host);
        else hosts[index] = host;
        await writeAll(hosts);
      }),
    remove: (hostKey) =>
      enqueue(async () => {
        await writeAll((await readAll()).filter((each) => each.hostKey !== hostKey));
      }),
  };
}
