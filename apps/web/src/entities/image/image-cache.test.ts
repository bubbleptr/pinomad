import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageRef, type MessageImage } from "@pinomad/protocol/images.ts";
import { ImageCache, imageCache, primeImages } from "./image-cache.ts";

const image = (data: string): MessageImage => ({ data, mimeType: "image/png" });

describe("ImageCache", () => {
  beforeEach(() => {
    imageCache.clear();
  });

  it("coalesces concurrent loads of one ref into a single request", async () => {
    const cache = new ImageCache();
    const bytes = image("aGVsbG8=");
    let calls = 0;
    let resolve!: (value: MessageImage) => void;
    const loader = (): Promise<MessageImage> => {
      calls += 1;
      return new Promise((done) => {
        resolve = done;
      });
    };

    const first = cache.load("ref-1", loader);
    const second = cache.load("ref-1", loader);
    expect(calls).toBe(1);
    resolve(bytes);

    await expect(first).resolves.toBe(bytes);
    await expect(second).resolves.toBe(bytes);
  });

  it("runs at most four loads at once and starts queued work as slots free up", async () => {
    const cache = new ImageCache();
    let started: { ref: string; resolve: (value: MessageImage) => void }[] = [];
    const loader = (ref: string): Promise<MessageImage> =>
      new Promise((resolve) => {
        started.push({ ref, resolve });
      });

    const loads = ["a", "b", "c", "d", "e", "f"].map((ref) => cache.load(ref, loader));
    expect(started.map((entry) => entry.ref)).toEqual(["a", "b", "c", "d"]);

    started[0]!.resolve(image("a"));
    await loads[0];
    expect(started.map((entry) => entry.ref)).toEqual(["a", "b", "c", "d", "e"]);

    for (const entry of started.slice(1)) entry.resolve(image(entry.ref));
    await vi.waitFor(() => expect(started).toHaveLength(6));
    started[5]!.resolve(image("f"));
    await Promise.all(loads);
    expect(cache.peek("f")).toEqual(image("f"));
  });

  it("evicts least-recently-used bytes by base64 length", () => {
    const cache = new ImageCache(120);
    const a = image("a".repeat(60));
    const b = image("b".repeat(60));
    const c = image("c".repeat(60));
    cache.prime("a", a);
    cache.prime("b", b);
    // Reading a makes b the oldest entry, so c's arrival evicts b, not a.
    expect(cache.get("a")).toBe(a);
    cache.prime("c", c);
    expect(cache.peek("a")).toBe(a);
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("c")).toBe(c);
  });

  it("does not remember a failed load, so the next attempt can succeed", async () => {
    const cache = new ImageCache();
    const bytes = image("aGVsbG8=");
    let attempts = 0;
    const loader = (): Promise<MessageImage> => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("host offline")) : Promise.resolve(bytes);
    };

    await expect(cache.load("ref-1", loader)).rejects.toThrow("host offline");
    expect(cache.peek("ref-1")).toBeUndefined();
    await expect(cache.load("ref-1", loader)).resolves.toBe(bytes);
    expect(attempts).toBe(2);
  });

  it("serves primed bytes without calling the loader", async () => {
    const bytes = image("aGVsbG8=");
    const ref = await imageRef(bytes);
    imageCache.prime(ref, bytes);
    const loader = vi.fn(async () => image("other"));

    await expect(imageCache.load(ref, loader)).resolves.toBe(bytes);
    expect(loader).not.toHaveBeenCalled();
  });

  it("hashes outgoing bytes into the cache before a send", async () => {
    const bytes = image("aGVsbG8=");
    await primeImages([bytes, { ref: "already-a-ref", mimeType: "image/png" }]);
    expect(imageCache.peek(await imageRef(bytes))).toBe(bytes);
  });
});
