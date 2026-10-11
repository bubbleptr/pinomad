import { describe, expect, it } from "vitest";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { createHostStore } from "./host-store.ts";

const key = (byte: number): string => toBase64Url(new Uint8Array(32).fill(byte));

const host = (byte: number, url = "ws://192.168.1.5:7422/secure") => ({
  url,
  hostKey: key(byte),
  privateKey: key(byte + 100),
});

/** In-memory KeyValueStorage; `failReads` makes getItemAsync throw. */
function makeStorage(initial?: string) {
  const raw = new Map<string, string>();
  if (initial !== undefined) raw.set("pinomad.hosts", initial);
  const storage = {
    raw,
    failReads: false,
    getItemAsync: (key: string): Promise<string | null> =>
      storage.failReads ? Promise.reject(new Error("keychain locked")) : Promise.resolve(raw.get(key) ?? null),
    setItemAsync: (key: string, value: string): Promise<void> => {
      raw.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string): Promise<void> => {
      raw.delete(key);
      return Promise.resolve();
    },
  };
  return storage;
}

describe("createHostStore", () => {
  it("lists nothing on an empty store", async () => {
    const store = createHostStore(makeStorage());
    expect(store.multiHost).toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("upserts by hostKey: same key replaces, a different key appends", async () => {
    const storage = makeStorage();
    const store = createHostStore(storage);
    const first = host(1);
    const updated = { ...first, url: "ws://10.0.0.2:7422/secure" };
    await store.save(first);
    await store.save(host(2));
    await store.save(updated);
    await expect(store.list()).resolves.toEqual([host(2), updated]);
  });

  it("drops invalid entries on read and keeps the valid ones", async () => {
    const valid = host(3);
    const stored = JSON.stringify([
      valid,
      { url: "ws://x", hostKey: "!!!not-base64!!!", privateKey: key(9) },
      { url: "ws://x", hostKey: key(4) }, // missing privateKey
      { url: "ws://x", hostKey: key(4), privateKey: toBase64Url(new Uint8Array(8)) }, // short key
      "not an object",
      42,
    ]);
    const store = createHostStore(makeStorage(stored));
    await expect(store.list()).resolves.toEqual([valid]);
  });

  it("returns [] for unparseable JSON and for a non-array document", async () => {
    await expect(createHostStore(makeStorage("{{{")).list()).resolves.toEqual([]);
    await expect(createHostStore(makeStorage('{"a":1}')).list()).resolves.toEqual([]);
  });

  it("returns [] when the read fails, but a save must not wipe the stored data", async () => {
    const storage = makeStorage(JSON.stringify([host(5)]));
    const store = createHostStore(storage);
    storage.failReads = true;
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.save(host(6))).rejects.toThrow("keychain locked");
    expect(storage.raw.get("pinomad.hosts")).toBe(JSON.stringify([host(5)]));
  });

  it("removes a host by hostKey and leaves others alone", async () => {
    const storage = makeStorage();
    const store = createHostStore(storage);
    await store.save(host(7));
    await store.save(host(8));
    await store.remove(key(7));
    await expect(store.list()).resolves.toEqual([host(8)]);
    await store.remove(key(8));
    await expect(store.list()).resolves.toEqual([]);
  });

  it("serializes read-modify-write: concurrent saves keep both hosts", async () => {
    // getItemAsync resolves only when the test releases it: without a queue,
    // save(B) and save(C) both read [A] and each write drops the other.
    const raw = new Map<string, string>([["pinomad.hosts", JSON.stringify([host(1)])]]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = {
      raw,
      getItemAsync: (key: string) => gate.then(() => raw.get(key) ?? null),
      setItemAsync: (key: string, value: string) => {
        raw.set(key, value);
        return Promise.resolve();
      },
    };
    const store = createHostStore(storage);
    const saveB = store.save(host(2));
    const saveC = store.save(host(3));
    release();
    await Promise.all([saveB, saveC]);
    await expect(store.list()).resolves.toEqual([host(1), host(2), host(3)]);
  });

  it("a rejected op does not block the next one", async () => {
    const storage = makeStorage(JSON.stringify([host(5)]));
    const store = createHostStore(storage);
    let writes = 0;
    const setItemAsync = storage.setItemAsync;
    storage.setItemAsync = (key, value) =>
      ++writes === 1 ? Promise.reject(new Error("keychain write failed")) : setItemAsync(key, value);
    await expect(store.save(host(6))).rejects.toThrow("keychain write failed");
    await store.save(host(7));
    await expect(store.list()).resolves.toEqual([host(5), host(7)]);
  });
});
