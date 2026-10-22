// Image bytes are content-addressed by ref (ADR-0027), so one process-wide
// cache serves every conversation, fork and side panel. Keeping it in memory
// is deliberate: refs are stable, but 100 MB of base64 is not worth persisting.
import { imageRef, type MessageImage, type ViewImage } from "@pinomad/protocol/images.ts";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;

export type ImageLoader = (ref: string) => Promise<MessageImage>;

type QueuedLoad = {
  readonly ref: string;
  readonly loader: ImageLoader;
  readonly resolve: (image: MessageImage) => void;
  readonly reject: (error: Error) => void;
};

export class ImageCache {
  readonly #maxBytes: number;
  /** Insertion order is the LRU order: oldest first. */
  readonly #bytes = new Map<string, MessageImage>();
  readonly #inflight = new Map<string, Promise<MessageImage>>();
  readonly #queue: QueuedLoad[] = [];
  #size = 0;
  #loading = 0;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** Bytes without touching recency — safe to call during render. */
  peek(ref: string): MessageImage | undefined {
    return this.#bytes.get(ref);
  }

  /** Bytes and mark them most recently used. */
  get(ref: string): MessageImage | undefined {
    const image = this.#bytes.get(ref);
    if (image === undefined) return undefined;
    this.#bytes.delete(ref);
    this.#bytes.set(ref, image);
    return image;
  }

  /** Put bytes in directly, as sending does once the client knows the ref. */
  prime(ref: string, image: MessageImage): void {
    const previous = this.#bytes.get(ref);
    if (previous !== undefined) this.#size -= previous.data.length;
    this.#bytes.delete(ref);
    this.#bytes.set(ref, image);
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
   * Bytes for `ref`, loading them at most once even when several components
   * ask together. The cache itself never remembers a failure: the next load
   * starts a new request, so a reconnect or remount can recover.
   */
  load(ref: string, loader: ImageLoader): Promise<MessageImage> {
    const cached = this.get(ref);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = this.#inflight.get(ref);
    if (inflight !== undefined) return inflight;

    const promise = new Promise<MessageImage>((resolve, reject) => {
      this.#queue.push({ ref, loader, resolve, reject });
    });
    this.#inflight.set(ref, promise);
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
      let request: Promise<MessageImage>;
      try {
        request = Promise.resolve(job.loader(job.ref));
      } catch (error) {
        this.#finish(job);
        job.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      void request.then(
        (image) => {
          this.prime(job.ref, image);
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
    this.#inflight.delete(job.ref);
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
