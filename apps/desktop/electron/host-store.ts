// The desktop's paired-host list: one encrypted blob in userData, written
// atomically. Pure file/cipher logic so vitest covers it without Electron —
// main.ts only supplies safeStorage and the userData path.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSecureServerOrigin, normalizeServerOrigin } from "@pinomad/client/account.ts";
import {
  mergeStoredHost,
  parseStoredHost,
  updateStoredHostConnection,
  updateStoredHostEndpoints,
  type StoredHost,
  type StoredHostConnectionChange,
} from "@pinomad/client/stored-host.ts";
import { parseConnectionMode } from "@pinomad/protocol/connection-mode.ts";
import { parseEndpointSet, type EndpointSet } from "@pinomad/protocol/endpoints.ts";

export type { StoredHost };

/** The encryption seam main.ts fills with safeStorage — injectable so tests need no keychain. */
export type Cipher = {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
};

/**
 * The bearer credential for the server-accounts API (ADR-0022 §2): which
 * server and the session token login returned. Stored next to the hosts —
 * the same safeStorage blob — never in renderer localStorage.
 */
export interface StoredAccount {
  readonly serverOrigin: string;
  readonly token: string;
}

export interface HostStore {
  list(): Promise<StoredHost[]>;
  /** Upsert by hostKey: re-pairing the same host refreshes url/privateKey in place. */
  save(host: StoredHost): Promise<void>;
  remove(hostKey: string): Promise<void>;
  /**
   * Cache the machine name the host announced (5.12): reads the entry inside
   * the same serialized queue, changes only `name`, and writes nothing when
   * the entry is gone — a name arriving after a forget must not resurrect it.
   */
  setName(hostKey: string, name: string): Promise<void>;
  /**
   * Apply a host-published remote set by hostKey inside the same serialized
   * queue: only endpoint fields move, and a forgotten host is not resurrected.
   */
  updateEndpoints(hostKey: string, endpointSet: EndpointSet): Promise<void>;
  /** Persist the connection mode or signal-only hint without touching any other field. */
  updateConnection(hostKey: string, change: StoredHostConnectionChange): Promise<void>;
  account(): Promise<StoredAccount | undefined>;
  saveAccount(account: StoredAccount): Promise<void>;
  clearAccount(): Promise<void>;
}

const FILE = "hosts.bin";

/** The renderer must not smuggle a plaintext origin or an empty token in. */
const parseStoredAccount = (value: unknown): StoredAccount | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const account = value as Record<string, unknown>;
  if (typeof account.serverOrigin !== "string" || !isSecureServerOrigin(account.serverOrigin)) return undefined;
  if (typeof account.token !== "string" || account.token === "") return undefined;
  return { serverOrigin: normalizeServerOrigin(account.serverOrigin), token: account.token };
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

  const readBlob = async (): Promise<{ hosts: StoredHost[]; account?: StoredAccount }> => {
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (error) {
      // Only a missing file means "nothing stored yet". Any other read failure
      // must surface: returning empty here would let a save overwrite it all.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hosts: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cipher.decrypt(data));
    } catch {
      // Never delete: move the blob aside so the next save can start over
      // without losing whatever it was. A timestamp keeps every backup, and a
      // failed move must reject — returning empty would let a write replace
      // the undecryptable original.
      const backup = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(file, backup);
      console.error(`pinomad: ${FILE} could not be decrypted — moved aside to ${backup}`);
      return { hosts: [] };
    }
    const blob = parsed as { hosts?: unknown; account?: unknown } | null;
    const hosts = Array.isArray(blob?.hosts)
      ? blob.hosts.flatMap((entry) => {
          // The payload crosses IPC — main must not trust the renderer's shape.
          const host = parseStoredHost(entry);
          return host === undefined ? [] : [host];
        })
      : [];
    const account = parseStoredAccount(blob?.account);
    return account === undefined ? { hosts } : { hosts, account };
  };

  const writeBlob = async (blob: { hosts: StoredHost[]; account?: StoredAccount }): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, cipher.encrypt(JSON.stringify({ version: 1, ...blob })));
    await rename(tmp, file);
  };

  return {
    list: () => enqueue(async () => (await readBlob()).hosts),
    save: (host) =>
      enqueue(async () => {
        if (parseStoredHost(host) === undefined) throw new Error("invalid host payload");
        const blob = await readBlob();
        const index = blob.hosts.findIndex((each) => each.hostKey === host.hostKey);
        if (index === -1) blob.hosts.push(host);
        else blob.hosts[index] = mergeStoredHost(blob.hosts[index]!, host);
        await writeBlob(blob);
      }),
    remove: (hostKey) =>
      enqueue(async () => {
        const blob = await readBlob();
        blob.hosts = blob.hosts.filter((each) => each.hostKey !== hostKey);
        await writeBlob(blob);
      }),
    setName: (hostKey, name) =>
      enqueue(async () => {
        const blob = await readBlob();
        const index = blob.hosts.findIndex((each) => each.hostKey === hostKey);
        if (index === -1) return;
        blob.hosts[index] = { ...blob.hosts[index]!, name };
        await writeBlob(blob);
      }),
    updateEndpoints: (hostKey, endpointSet) =>
      enqueue(async () => {
        const parsed = parseEndpointSet(endpointSet);
        if (parsed.kind !== "valid") throw new Error("invalid endpoint set");
        const blob = await readBlob();
        const index = blob.hosts.findIndex((each) => each.hostKey === hostKey);
        if (index === -1) return;
        blob.hosts[index] = updateStoredHostEndpoints(blob.hosts[index]!, parsed.endpointSet);
        await writeBlob(blob);
      }),
    updateConnection: (hostKey, change) =>
      enqueue(async () => {
        // The renderer crosses IPC here, so validate both fields before they
        // reach the stored record.
        if (change === null || typeof change !== "object") throw new Error("invalid connection payload");
        if (change.connectionMode !== undefined && parseConnectionMode(change.connectionMode) === undefined) {
          throw new Error("invalid connection mode");
        }
        if (change.rtcSignalOnly !== undefined && typeof change.rtcSignalOnly !== "boolean") {
          throw new Error("invalid signal-only hint");
        }
        const blob = await readBlob();
        const index = blob.hosts.findIndex((each) => each.hostKey === hostKey);
        if (index === -1) return;
        blob.hosts[index] = updateStoredHostConnection(blob.hosts[index]!, change);
        await writeBlob(blob);
      }),
    account: () => enqueue(async () => (await readBlob()).account),
    saveAccount: (account) =>
      enqueue(async () => {
        if (parseStoredAccount(account) === undefined) throw new Error("invalid account payload");
        const blob = await readBlob();
        blob.account = { serverOrigin: normalizeServerOrigin(account.serverOrigin), token: account.token };
        await writeBlob(blob);
      }),
    clearAccount: () =>
      enqueue(async () => {
        const blob = await readBlob();
        delete blob.account;
        await writeBlob(blob);
      }),
  };
}
