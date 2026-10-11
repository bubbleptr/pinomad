// The desktop's paired-host list: one encrypted blob in userData, written
// atomically. Pure file/cipher logic so vitest covers it without Electron —
// main.ts only supplies safeStorage and the userData path.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStoredHost, type StoredHost } from "@pinomad/client/stored-host.ts";

export type { StoredHost };

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
    } catch (error) {
      // Only a missing file means "no hosts yet". Any other read failure must
      // surface: returning [] here would let a save overwrite the real list.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cipher.decrypt(data));
    } catch {
      // Never delete: move the blob aside so the next save can start over
      // without losing whatever it was. A timestamp keeps every backup, and a
      // failed move must reject — returning [] would let a write replace the
      // undecryptable original.
      const backup = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(file, backup);
      console.error(`pinomad: ${FILE} could not be decrypted — moved aside to ${backup}`);
      return [];
    }
    const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
    if (!Array.isArray(hosts)) return [];
    return hosts.flatMap((entry) => {
      // The payload crosses IPC — main must not trust the renderer's shape.
      const host = parseStoredHost(entry);
      return host === undefined ? [] : [host];
    });
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
        if (parseStoredHost(host) === undefined) throw new Error("invalid host payload");
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
