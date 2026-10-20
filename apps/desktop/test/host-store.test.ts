// The paired-host list behind safeStorage, exercised with a fake cipher and a
// temp dir — no Electron, no keychain.
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { createHostStore, type Cipher, type StoredHost } from "../electron/host-store.ts";

// A reversible marker cipher: the blob proves it went through encrypt(), and
// decrypt() refuses anything without the marker, like safeStorage refusing a
// blob from another keychain.
const cipher: Cipher = {
  encrypt: (plain) => Buffer.from(`ENC1:${Buffer.from(plain, "utf8").toString("base64url")}`, "utf8"),
  decrypt: (data) => {
    const text = data.toString("utf8");
    if (!text.startsWith("ENC1:")) throw new Error("cannot decrypt");
    return Buffer.from(text.slice("ENC1:".length), "base64url").toString("utf8");
  },
};

const dirs: string[] = [];
const tempStore = async (): Promise<{ store: ReturnType<typeof createHostStore>; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-host-store-"));
  dirs.push(dir);
  return { store: createHostStore(dir, cipher), dir };
};

afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const host = (url = "ws://127.0.0.1:7420/secure"): StoredHost => ({
  url,
  hostKey: toBase64Url(generateKeyPair().publicKey),
  privateKey: toBase64Url(generateKeyPair().privateKey),
});

// Root ignores permission bits, so the chmod-based tests can't exercise errors.
const isRoot = process.getuid?.() === 0;

describe("createHostStore", () => {
  it("round-trips saved hosts, and the file holds no plaintext keys", async () => {
    const { store, dir } = await tempStore();
    const a = host();
    await store.save(a);
    expect(await store.list()).toEqual([a]);

    const raw = await readFile(join(dir, "hosts.bin"));
    expect(raw.includes(a.hostKey)).toBe(false);
    expect(raw.includes(a.privateKey)).toBe(false);
  });

  it("lists nothing when the file is missing", async () => {
    const { store } = await tempStore();
    expect(await store.list()).toEqual([]);
  });

  it("upserts by hostKey: re-saving replaces url and privateKey in place", async () => {
    const { store } = await tempStore();
    const a = host();
    const b = host("ws://10.0.0.9:7420/secure");
    await store.save(a);
    await store.save(b);
    const moved = { ...a, url: "wss://relay.example.com/c/abc", privateKey: toBase64Url(generateKeyPair().privateKey) };
    await store.save(moved);
    expect(await store.list()).toEqual([moved, b]);
  });

  it("removes only the named host", async () => {
    const { store } = await tempStore();
    const a = host();
    const b = host("ws://10.0.0.9:7420/secure");
    await store.save(a);
    await store.save(b);
    await store.remove(a.hostKey);
    expect(await store.list()).toEqual([b]);
    await store.remove("not-a-stored-key");
    expect(await store.list()).toEqual([b]);
  });

  it("quarantines an undecryptable file and keeps working", async () => {
    const { store, dir } = await tempStore();
    await writeFile(join(dir, "hosts.bin"), "not a ciphertext");
    expect(await store.list()).toEqual([]);

    const backups = (await readdir(dir)).filter((name) => name.startsWith("hosts.bin.unreadable-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe("not a ciphertext");

    const a = host();
    await store.save(a);
    expect(await store.list()).toEqual([a]);
  });

  it("keeps a separate backup for every corruption", async () => {
    const { store, dir } = await tempStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
      await writeFile(join(dir, "hosts.bin"), "junk one");
      expect(await store.list()).toEqual([]);
      vi.setSystemTime(new Date("2026-10-11T00:00:01.000Z"));
      await writeFile(join(dir, "hosts.bin"), "junk two");
      expect(await store.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }

    const backups = (await readdir(dir)).filter((name) => name.startsWith("hosts.bin.unreadable-")).sort();
    expect(backups).toHaveLength(2);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe("junk one");
    expect(await readFile(join(dir, backups[1]!), "utf8")).toBe("junk two");
  });

  it.skipIf(isRoot)("fails reads instead of letting a save overwrite the real list", async () => {
    const { store, dir } = await tempStore();
    const a = host();
    await store.save(a);
    const file = join(dir, "hosts.bin");
    await chmod(file, 0o000);
    try {
      await expect(store.save(host("ws://10.0.0.9:7420/secure"))).rejects.toThrow();
      await expect(store.list()).rejects.toThrow();
    } finally {
      await chmod(file, 0o644);
    }
    expect(await store.list()).toEqual([a]);
  });

  it.skipIf(isRoot)("fails instead of writing over an undecryptable file it cannot move aside", async () => {
    const { store, dir } = await tempStore();
    await writeFile(join(dir, "hosts.bin"), "junk bytes");
    await chmod(dir, 0o555);
    try {
      await expect(store.list()).rejects.toThrow();
    } finally {
      await chmod(dir, 0o755);
    }
    expect(await readFile(join(dir, "hosts.bin"), "utf8")).toBe("junk bytes");
  });

  it("drops invalid entries from a readable file", async () => {
    const { store, dir } = await tempStore();
    const good = host();
    const blob = cipher.encrypt(
      JSON.stringify({ version: 1, hosts: [good, { url: "ws://x", hostKey: "short", privateKey: "short" }, "junk"] }),
    );
    await writeFile(join(dir, "hosts.bin"), blob);
    expect(await store.list()).toEqual([good]);
  });

  it("rejects malformed payloads instead of storing them", async () => {
    const { store } = await tempStore();
    const a = host();
    await expect(store.save({ ...a, hostKey: "tooshort" })).rejects.toThrow();
    await expect(store.save({ ...a, privateKey: "tooshort" })).rejects.toThrow();
    await expect(store.save({ ...a, url: "http://not-a-socket" })).rejects.toThrow();
    await expect(store.save({ ...a, url: "not a url" })).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("setName rewrites only the name inside the serialized queue", async () => {
    const { store } = await tempStore();
    const a = {
      ...host(),
      account: { serverOrigin: "https://relay.example.com", hostId: toBase64Url(generateKeyPair().publicKey) },
    };
    await store.save(a);
    await store.setName(a.hostKey, "Desk");
    expect(await store.list()).toEqual([{ ...a, name: "Desk" }]);
    await store.setName(a.hostKey, "Bench");
    expect(await store.list()).toEqual([{ ...a, name: "Bench" }]);
  });

  it("setName writes nothing for an entry that is not there", async () => {
    const { store, dir } = await tempStore();
    const a = host();
    await store.save(a);
    await store.remove(a.hostKey);
    // A name arriving after the entry was removed must not resurrect it —
    // and must not rewrite the file at all.
    await store.setName(a.hostKey, "Desk");
    expect(await store.list()).toEqual([]);
    const raw = JSON.parse(cipher.decrypt(await readFile(join(dir, "hosts.bin"))));
    expect(raw.hosts).toEqual([]);
  });

  it("round-trips the account credential encrypted, independent of the hosts", async () => {
    const { store, dir } = await tempStore();
    expect(await store.account()).toBeUndefined();

    await store.saveAccount({ serverOrigin: "https://relay.example.com/", token: "session-token" });
    // The stored origin is normalized — the token lands only in ciphertext.
    expect(await store.account()).toEqual({ serverOrigin: "https://relay.example.com", token: "session-token" });
    const raw = await readFile(join(dir, "hosts.bin"));
    expect(raw.includes("session-token")).toBe(false);
    expect(raw.includes("relay.example.com")).toBe(false);

    // Saving a host keeps the account; clearing drops it and nothing else.
    const a = host();
    await store.save(a);
    expect(await store.account()).toMatchObject({ token: "session-token" });
    await store.clearAccount();
    expect(await store.account()).toBeUndefined();
    expect(await store.list()).toEqual([a]);
  });

  it("rejects account payloads with a plaintext origin or empty token", async () => {
    const { store } = await tempStore();
    await expect(store.saveAccount({ serverOrigin: "http://lan.example.com", token: "t" })).rejects.toThrow();
    await expect(store.saveAccount({ serverOrigin: "not a url", token: "t" })).rejects.toThrow();
    await expect(store.saveAccount({ serverOrigin: "https://ok.example.com", token: "" })).rejects.toThrow();
    await expect(store.saveAccount({ serverOrigin: "http://127.0.0.1:7430", token: "t" })).resolves.toBeUndefined();
    expect((await store.account())?.serverOrigin).toBe("http://127.0.0.1:7430");
  });
});
