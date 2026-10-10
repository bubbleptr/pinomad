// The paired-host list behind safeStorage, exercised with a fake cipher and a
// temp dir — no Electron, no keychain.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
    await stat(join(dir, "hosts.bin.unreadable"));

    const a = host();
    await store.save(a);
    expect(await store.list()).toEqual([a]);
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
});
