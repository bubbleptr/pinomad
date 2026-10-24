// File attachments (issue #321): the host-side upload state machine, budget,
// cleanup and the submit/cleanup lock. The host's data-dir lock guarantees a
// single process, so the store's own promise chain is the whole concurrency
// story.
import { chmod, mkdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TTL_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@pinomad/protocol/attachments.ts";
import { AttachmentStore, attachmentFileName } from "../src/attachments.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

async function openStore(
  options: Partial<ConstructorParameters<typeof AttachmentStore>[0]> = {},
): Promise<{ store: AttachmentStore; dir: string }> {
  const dir = await tempDir();
  defer(dir.remove);
  const store = new AttachmentStore({ dir: join(dir.path, "attachments"), ...options });
  defer(() => store.close());
  await store.open();
  return { store, dir: dir.path };
}

const b64 = (text: string): string => Buffer.from(text).toString("base64");

describe("attachmentFileName", () => {
  it("takes the basename, replaces separators and controls, and trims leading dots", () => {
    expect(attachmentFileName("../../etc/passwd")).toBe("passwd");
    expect(attachmentFileName("C:\\Users\\x\\a.txt")).toBe("a.txt");
    expect(attachmentFileName("  .hidden  ")).toBe("hidden");
    expect(attachmentFileName("a\u0001b\nc.txt")).toBe("a_b_c.txt");
    expect(attachmentFileName("..")).toBe("file");
    expect(attachmentFileName("   ")).toBe("file");
  });

  it("caps the UTF-8 bytes without splitting a code point and keeps the extension", () => {
    const long = `${"a".repeat(300)}.txt`;
    const name = attachmentFileName(long);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(200);
    expect(name.endsWith(".txt")).toBe(true);
    const unicode = attachmentFileName("é".repeat(200));
    expect(Buffer.byteLength(unicode, "utf8")).toBeLessThanOrEqual(200);
    expect(unicode).toBe("é".repeat(100));
  });
});

describe("AttachmentStore", () => {
  it("completes a zero-byte upload at begin and answers retries", async () => {
    const { store, dir } = await openStore();
    const id = await store.begin("empty.txt", 0);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.parse(await readFile(join(dir, "attachments", id, "meta.json"), "utf8"))).toMatchObject({
      state: "complete",
      size: 0,
      name: "empty.txt",
    });
    expect(await store.append(id, 99, "!!!")).toEqual({ received: 0, complete: true });
  });

  it("uploads chunks, marks complete 0444, and ignores offset after completion", async () => {
    const { store, dir } = await openStore();
    const id = await store.begin("hello.txt", 5);
    expect(await store.append(id, 0, b64("hello"))).toEqual({ received: 5, complete: true });
    const path = join(dir, "attachments", id, "hello.txt");
    expect(await readFile(path, "utf8")).toBe("hello");
    expect((await stat(path)).mode & 0o777).toBe(0o444);
    expect(await store.append(id, 0, b64("hello"))).toEqual({ received: 5, complete: true });
    expect(await store.append(id, 5, "!!!!")).toEqual({ received: 5, complete: true });
  });

  it("returns the current size for a duplicate or out-of-order chunk", async () => {
    const { store, dir } = await openStore();
    const id = await store.begin("six.txt", 6);
    expect(await store.append(id, 3, b64("def"))).toEqual({ received: 0, complete: false });
    expect(await readFile(join(dir, "attachments", id, "six.txt"), "utf8")).toBe("");
    expect(await store.append(id, 0, b64("abc"))).toEqual({ received: 3, complete: false });
    // The reply to the first append was "lost": the client retries the same chunk.
    expect(await store.append(id, 0, b64("abc"))).toEqual({ received: 3, complete: false });
    expect(await store.append(id, 3, b64("def"))).toEqual({ received: 6, complete: true });
  });

  it("serializes concurrent appends to one id deterministically", async () => {
    const { store } = await openStore();
    const id = await store.begin("six.txt", 6);
    const [first, second] = await Promise.all([
      store.append(id, 0, b64("abc")),
      store.append(id, 3, b64("def")),
    ]);
    expect(first).toEqual({ received: 3, complete: false });
    expect(second).toEqual({ received: 6, complete: true });
    expect(await store.append(id, 0, b64("abc"))).toEqual({ received: 6, complete: true });
  });

  it("recovers a full file whose completion meta write was lost", async () => {
    const { store, dir } = await openStore();
    const id = await store.begin("five.txt", 5);
    await writeFile(join(dir, "attachments", id, "five.txt"), "hello");
    expect(await store.append(id, 0, b64("hello"))).toEqual({ received: 5, complete: true });
    const meta = JSON.parse(await readFile(join(dir, "attachments", id, "meta.json"), "utf8"));
    expect(meta.state).toBe("complete");
    expect((await stat(join(dir, "attachments", id, "five.txt"))).mode & 0o777).toBe(0o444);
  });

  it("recovers an upload after a host restart", async () => {
    const first = await openStore();
    const id = await first.store.begin("six.txt", 6);
    expect(await first.store.append(id, 0, b64("abc"))).toEqual({ received: 3, complete: false });
    first.store.close();

    const second = await openStore({ dir: join(first.dir, "attachments") });
    expect(await second.store.append(id, 3, b64("def"))).toEqual({ received: 6, complete: true });
  });

  it("rejects illegal base64, oversized chunks, and chunks beyond the promised size", async () => {
    const { store } = await openStore();
    const id = await store.begin("small.txt", 5);
    await expect(store.append(id, 0, "!!!!")).rejects.toThrow(/base64/);
    await expect(store.append(id, 0, "A".repeat(699052))).rejects.toThrow(/512 KiB/);
    await expect(store.append(id, 0, b64("toolong"))).rejects.toThrow(/remaining size/);
    await expect(store.begin("huge.bin", MAX_ATTACHMENT_BYTES + 1)).rejects.toThrow(/10 MB/);
  });

  it("enforces the pending count and byte budgets until attachments are used", async () => {
    const { store } = await openStore({ pendingLimit: 2, pendingBytesLimit: 100 });
    const first = await store.begin("a", 0);
    const second = await store.begin("b", 0);
    await expect(store.begin("c", 0)).rejects.toThrow(/Too many pending/);

    await store.use([first]);
    // The used file leaves the budget; a complete zero-byte file still counts.
    const third = await store.begin("c", 0);
    expect(third).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(store.begin("d", 0)).rejects.toThrow(/Too many pending/);
    await store.use([second, third]);

    const bytes = await openStore({ pendingLimit: 10, pendingBytesLimit: 10 });
    await bytes.store.begin("six", 6);
    await expect(bytes.store.begin("five", 5)).rejects.toThrow(/MB budget/);
  });

  it("validates every id, state, and regular file before marking any used", async () => {
    const { store, dir } = await openStore();
    const uploading = await store.begin("up.txt", 5);
    await expect(store.use([uploading])).rejects.toThrow(/still uploading/);
    await expect(store.use(["A".repeat(22)])).rejects.toThrow(/expired/);

    const complete = await store.begin("done.txt", 5);
    await store.append(complete, 0, b64("hello"));
    await chmod(join(dir, "attachments", complete, "done.txt"), 0o644);
    await truncate(join(dir, "attachments", complete, "done.txt"), 4);
    await expect(store.use([complete])).rejects.toThrow(/unavailable/);

    const linked = await store.begin("link.txt", 0);
    const target = join(dir, "elsewhere.txt");
    await writeFile(target, "hello");
    await rm(join(dir, "attachments", linked, "link.txt"));
    await symlink(target, join(dir, "attachments", linked, "link.txt"));
    await expect(store.use([linked])).rejects.toThrow(/unavailable/);

    const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => complete);
    await expect(store.use(tooMany)).rejects.toThrow(/At most 10/);
    // Nothing above was marked used: the uploading file still reports progress.
    expect(await store.append(uploading, 0, b64("hello"))).toEqual({ received: 5, complete: true });
  });

  it("sweeps expired unused uploads but never used ones", async () => {
    let now = 0;
    const { store, dir } = await openStore({ now: () => now, ttlMs: 100 });
    const expired = await store.begin("expired.txt", 5);
    const used = await store.begin("used.txt", 0);
    await store.use([used]);
    now = 101;
    expect(await store.sweep()).toBe(1);
    await expect(stat(join(dir, "attachments", expired))).rejects.toThrow();
    expect((await stat(join(dir, "attachments", used))).isDirectory()).toBe(true);

    // A used file stays even long after its expiresAt.
    now = ATTACHMENT_TTL_MS * 10;
    expect(await store.sweep()).toBe(0);
    expect((await stat(join(dir, "attachments", used))).isDirectory()).toBe(true);
  });

  it("removes an old directory with missing or broken meta, but not a fresh one", async () => {
    let now = 10 * ATTACHMENT_TTL_MS;
    const { store, dir } = await openStore({ now: () => now, ttlMs: 100 });
    const old = join(dir, "attachments", "old");
    const fresh = join(dir, "attachments", "fresh");
    const broken = join(dir, "attachments", "broken");
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "meta.json"), "{not json");
    const past = new Date(now - 1000);
    await utimes(old, past, past);
    await utimes(broken, past, past);
    expect(await store.sweep()).toBe(2);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(broken)).rejects.toThrow();
    expect((await stat(fresh)).isDirectory()).toBe(true);
  });

  it("keeps an attachment a concurrent submit marked used before the sweep", async () => {
    let now = 0;
    const { store, dir } = await openStore({ now: () => now, ttlMs: 10 });
    const id = await store.begin("done.txt", 0);
    now = 20;
    // Both enter the store's lock in call order, like a submit racing cleanup.
    const use = store.use([id]);
    const sweep = store.sweep();
    expect(await use).toHaveLength(1);
    await sweep;
    expect((await stat(join(dir, "attachments", id))).isDirectory()).toBe(true);
  });
});
