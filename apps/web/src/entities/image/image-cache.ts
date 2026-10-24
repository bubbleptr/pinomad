// Image bytes are content-addressed by ref and variant (ADR-0027, #311), so
// one process-wide cache serves every conversation, fork and side panel.
// Keeping it in memory is deliberate: 100 MB of base64 is not worth persisting.
import { imageRef, type ImageResult, type ImageVariant, type MessageImage, type ViewImage } from "@pinomad/protocol/images.ts";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;

export type ImageLoader = (ref: string, variant?: ImageVariant) => Promise<ImageResult>;

type QueuedLoad = {
  readonly key: string;
  readonly ref: string;
  readonly variant: ImageVariant;
  readonly loader: ImageLoader;
  readonly resolve: (image: ImageResult) => void;
  readonly reject: (error: Error) => void;
};

const keyOf = (ref: string, variant: ImageVariant): string => `${variant}:${ref}`;

export class ImageCache {
  readonly #maxBytes: number;
  /** Insertion order is the LRU order: oldest first. */
  readonly #bytes = new Map<string, ImageResult>();
  readonly #inflight = new Map<string, Promise<ImageResult>>();
  readonly #queue: QueuedLoad[] = [];
  #size = 0;
  #loading = 0;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** Bytes without touching recency — safe to call during render. */
  peek(ref: string, variant: ImageVariant = "original"): ImageResult | undefined {
    const direct = this.#bytes.get(keyOf(ref, variant));
    if (direct !== undefined || variant === "original") return direct;
    return this.#bytes.get(keyOf(ref, "original"));
  }

  /** Bytes and mark them most recently used. */
  get(ref: string, variant: ImageVariant = "original"): ImageResult | undefined {
    let key = keyOf(ref, variant);
    if (!this.#bytes.has(key) && variant !== "original") key = keyOf(ref, "original");
    const image = this.#bytes.get(key);
    if (image === undefined) return undefined;
    this.#bytes.delete(key);
    this.#bytes.set(key, image);
    return image;
  }

  /** Put bytes in directly, as sending does once the client knows the ref. */
  prime(ref: string, image: ImageResult, variant: ImageVariant = "original"): void {
    const key = keyOf(ref, variant);
    const previous = this.#bytes.get(key);
    if (previous !== undefined) this.#size -= previous.data.length;
    this.#bytes.delete(key);
    this.#bytes.set(key, image);
    this.#size += image.data.length;
    while (this.#size > this.#maxBytes) {
      const oldest = this.#bytes.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#bytes.get(oldest)!;
      this.#bytes.delete(oldest);
      this.#size -= evicted.data.length;
    }
  }

  /**
   * Bytes for one variant, loading equal requests once. A cached or in-flight
   * original also serves derived display requests, never the other way around.
   */
  load(ref: string, loader: ImageLoader, variant: ImageVariant = "original"): Promise<ImageResult> {
    const cached = this.get(ref, variant);
    if (cached !== undefined) return Promise.resolve(cached);
    const key = keyOf(ref, variant);
    const inflight = this.#inflight.get(key)
      ?? (variant === "original" ? undefined : this.#inflight.get(keyOf(ref, "original")));
    if (inflight !== undefined) return inflight;

    const promise = new Promise<ImageResult>((resolve, reject) => {
      this.#queue.push({ key, ref, variant, loader, resolve, reject });
    });
    this.#inflight.set(key, promise);
    this.#pump();
    return promise;
  }

  /** Drop everything, including queued work. Tests use it; the app keeps one cache for its lifetime. */
  clear(): void {
    this.#bytes.clear();
    this.#inflight.clear();
    this.#queue.length = 0;
    this.#size = 0;
    this.#loading = 0;
  }

  #pump(): void {
    while (this.#loading < MAX_IN_FLIGHT) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      this.#loading += 1;
      let request: Promise<ImageResult>;
      try {
        request = Promise.resolve(job.variant === "original" ? job.loader(job.ref) : job.loader(job.ref, job.variant));
      } catch (error) {
        this.#finish(job);
        job.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      void request.then(
        (image) => {
          this.prime(job.ref, image, image.variant ?? "original");
          this.#finish(job);
          job.resolve(image);
        },
        (error: unknown) => {
          this.#finish(job);
          job.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }
  }

  #finish(job: QueuedLoad): void {
    this.#inflight.delete(job.key);
    this.#loading -= 1;
    this.#pump();
  }
}

/** The app's cache. Ref equality is content equality, so it outlives any one conversation. */
export const imageCache = new ImageCache();

/** Bytes for a view image, from the cache or the host. */
export async function loadImageBytes(image: ViewImage, loader: ImageLoader): Promise<MessageImage> {
  if ("data" in image) return image;
  return imageCache.load(image.ref, loader);
}

/**
 * Prefill what a send is about to upload, so its ref snapshot resolves from
 * memory instead of a round trip. Hashing can fail on a browser without
 * WebCrypto; sending must still work, so the fetch path remains the fallback.
 */
export async function primeImages(images: readonly ViewImage[]): Promise<void> {
  await Promise.all(
    images.map(async (image) => {
      if (!("data" in image)) return;
      try {
        imageCache.prime(await imageRef(image), image);
      } catch {
        // Optimization only: the sent bytes stay authoritative.
      }
    }),
  );
}
