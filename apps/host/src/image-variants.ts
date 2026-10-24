import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { DerivedImageVariant, ImageMimeType, MessageImage } from "@pinomad/protocol/images.ts";

const PROFILES: Record<DerivedImageVariant, ImageLimits> = {
  thumbnail: { maxWidth: 768, maxHeight: 768, maxBytes: 128 * 1024 },
  preview: { maxWidth: 1536, maxHeight: 1536, maxBytes: 384 * 1024 },
};

type DerivedResult = MessageImage & { readonly variant: DerivedImageVariant };
type VariantResult = MessageImage & { readonly variant: DerivedImageVariant | "original" };
type QueuedVariant = {
  readonly key: string;
  readonly variant: DerivedImageVariant;
  readonly original: MessageImage;
  readonly resolve: (result: VariantResult) => void;
  readonly reject: (error: Error) => void;
};

const MAX_IN_FLIGHT = 2;

export class ImageVariants {
  readonly #processor: ImageProcessor | undefined;
  readonly #maxCacheBytes: number;
  readonly #cache = new Map<string, DerivedResult>();
  readonly #pending = new Map<string, Promise<VariantResult>>();
  readonly #queue: QueuedVariant[] = [];
  #cacheBytes = 0;
  #active = 0;

  constructor(processor?: ImageProcessor, options: { maxCacheBytes?: number } = {}) {
    this.#processor = processor;
    this.#maxCacheBytes = options.maxCacheBytes ?? 32 * 1024 * 1024;
  }

  async get(ref: string, variant: DerivedImageVariant, original: MessageImage): Promise<VariantResult> {
    const key = `${variant}:${ref}`;
    const cached = this.#read(key);
    if (cached !== undefined) return cached;
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      pending = new Promise<VariantResult>((resolve, reject) => {
        this.#queue.push({ key, variant, original, resolve, reject });
      });
      this.#pending.set(key, pending);
      this.#pump();
    }
    try {
      return await pending;
    } finally {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
    }
  }

  #pump(): void {
    while (this.#active < MAX_IN_FLIGHT) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      this.#active += 1;
      void this.#derive(job.key, job.variant, job.original).then(
        (result) => {
          job.resolve(result);
          this.#finish();
        },
        (error: unknown) => {
          job.reject(error instanceof Error ? error : new Error(String(error)));
          this.#finish();
        },
      );
    }
  }

  #finish(): void {
    this.#active -= 1;
    this.#pump();
  }

  async #derive(key: string, variant: DerivedImageVariant, original: MessageImage): Promise<VariantResult> {
    if (this.#processor === undefined) return { ...original, variant: "original" };
    try {
      // Buffer's slice/transfer semantics can break the Photon worker; give it a plain copy.
      const bytes = new Uint8Array(Buffer.from(original.data, "base64"));
      const prepared = await this.#processor.prepare(bytes, original.mimeType, PROFILES[variant]);
      if (prepared === undefined || (prepared.data === original.data && prepared.mimeType === original.mimeType)) {
        return { ...original, variant: "original" };
      }
      const result: DerivedResult = {
        data: prepared.data,
        mimeType: prepared.mimeType as ImageMimeType,
        variant,
      };
      this.#write(key, result);
      return result;
    } catch {
      return { ...original, variant: "original" };
    }
  }

  #read(key: string): DerivedResult | undefined {
    const cached = this.#cache.get(key);
    if (cached === undefined) return undefined;
    this.#cache.delete(key);
    this.#cache.set(key, cached);
    return cached;
  }

  #write(key: string, result: DerivedResult): void {
    const bytes = result.data.length;
    if (bytes > this.#maxCacheBytes) return;
    while (this.#cacheBytes + bytes > this.#maxCacheBytes) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const previous = this.#cache.get(oldest)!;
      this.#cache.delete(oldest);
      this.#cacheBytes -= previous.data.length;
    }
    this.#cache.set(key, result);
    this.#cacheBytes += bytes;
  }
}
