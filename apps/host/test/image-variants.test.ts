import { describe, expect, it, vi } from "vitest";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";
import { ImageVariants } from "../src/image-variants.ts";
import { imageSize, solidPng } from "./support.ts";

const PNG = { data: "aGVsbG8=", mimeType: "image/png" as const };
const THUMB = { data: "VEhVTUI=", mimeType: "image/jpeg" as const, variant: "thumbnail" as const };
const PREVIEW = { data: "UFJFVklFVw==", mimeType: "image/jpeg" as const, variant: "preview" as const };

describe("ImageVariants", () => {
  it("uses bounded fixed profiles, coalesces equal work, and separates variants", async () => {
    const limits: ImageLimits[] = [];
    let preparations = 0;
    const processor: ImageProcessor = {
      prepare: async (_bytes, _mimeType, nextLimits) => {
        preparations += 1;
        limits.push(nextLimits);
        await Promise.resolve();
        return nextLimits.maxWidth === 768 ? THUMB : PREVIEW;
      },
    };
    const variants = new ImageVariants(processor, { maxCacheBytes: 1024 });

    const [first, second, preview] = await Promise.all([
      variants.get("ref", "thumbnail", PNG),
      variants.get("ref", "thumbnail", PNG),
      variants.get("ref", "preview", PNG),
    ]);
    expect(first).toEqual(THUMB);
    expect(second).toEqual(THUMB);
    expect(preview).toEqual(PREVIEW);
    expect(preparations).toBe(2);
    expect(limits).toContainEqual({ maxWidth: 768, maxHeight: 768, maxBytes: 128 * 1024 });
    expect(limits).toContainEqual({ maxWidth: 1536, maxHeight: 1536, maxBytes: 384 * 1024 });

    expect(await variants.get("ref", "thumbnail", PNG)).toEqual(THUMB);
    expect(preparations).toBe(2);
  });

  it("passes plain Uint8Array bytes to the worker-backed processor", async () => {
    let received: Uint8Array | undefined;
    const variants = new ImageVariants({
      prepare: async (bytes) => {
        received = bytes;
        return THUMB;
      },
    });
    await variants.get("ref", "thumbnail", PNG);

    expect(received).toBeInstanceOf(Uint8Array);
    expect(received).not.toBeInstanceOf(Buffer);
    expect(Array.from(received!)).toEqual(Array.from(Buffer.from(PNG.data, "base64")));
  });

  it("reports the original when processing fails or returns the same bytes", async () => {
    const unavailable = new ImageVariants({ prepare: async () => undefined });
    expect(await unavailable.get("ref", "thumbnail", PNG)).toEqual({ ...PNG, variant: "original" });

    const unchanged = new ImageVariants({ prepare: async () => PNG });
    expect(await unchanged.get("ref", "preview", PNG)).toEqual({ ...PNG, variant: "original" });

    const broken = new ImageVariants({ prepare: async () => { throw new Error("worker stopped"); } });
    expect(await broken.get("ref", "thumbnail", PNG)).toEqual({ ...PNG, variant: "original" });

    const missing = new ImageVariants();
    expect(await missing.get("ref", "preview", PNG)).toEqual({ ...PNG, variant: "original" });
  });

  it("limits different derivations to two in flight", async () => {
    const started: { resolve: (image: { data: string; mimeType: string }) => void }[] = [];
    const processor: ImageProcessor = {
      prepare: async () => new Promise((resolve) => started.push({ resolve })),
    };
    const variants = new ImageVariants(processor);
    const loads = ["a", "b", "c", "d"].map((ref) => variants.get(ref, "thumbnail", PNG));
    expect(started).toHaveLength(2);

    started[0]!.resolve(THUMB);
    await loads[0];
    expect(started).toHaveLength(3);
    started[1]!.resolve(THUMB);
    started[2]!.resolve(THUMB);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    started[3]!.resolve(THUMB);
    await Promise.all(loads);
  });

  it("evicts the least recently used derived image within the byte budget", async () => {
    const data = ["AAAA", "BBBB", "CCCC", "DDDD"];
    let preparations = 0;
    const processor: ImageProcessor = {
      prepare: async () => ({ data: data[preparations++], mimeType: "image/png" }),
    };
    const variants = new ImageVariants(processor, { maxCacheBytes: 8 });
    await variants.get("a", "thumbnail", PNG);
    await variants.get("b", "thumbnail", PNG);
    await variants.get("a", "thumbnail", PNG);
    await variants.get("c", "thumbnail", PNG);
    expect(preparations).toBe(3);

    await variants.get("a", "thumbnail", PNG);
    expect(preparations).toBe(3);
    await variants.get("b", "thumbnail", PNG);
    expect(preparations).toBe(4);
  });

  it("creates bounded derivatives with the real Photon processor", async () => {
    const variants = new ImageVariants(await createNodePhotonImages());
    const original = { data: solidPng(1600, 900, [200, 40, 40]).toString("base64"), mimeType: "image/png" as const };

    const thumbnail = await variants.get("real", "thumbnail", original);
    expect(thumbnail.variant).toBe("thumbnail");
    expect(thumbnail.data.length).toBeLessThanOrEqual(128 * 1024);
    expect(imageSize(Buffer.from(thumbnail.data, "base64"))).toEqual({ width: 768, height: 432 });

    const preview = await variants.get("real", "preview", original);
    expect(preview.variant).toBe("preview");
    expect(preview.data.length).toBeLessThanOrEqual(384 * 1024);
    expect(imageSize(Buffer.from(preview.data, "base64"))).toEqual({ width: 1536, height: 864 });
  });
});
