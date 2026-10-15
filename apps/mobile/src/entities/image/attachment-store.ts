// Composer attachment state as a plain store (no React, no native imports)
// so vitest covers the bookkeeping: which images are staged, preparation
// progress, and the last problem the user hit. The host enforces the same
// limits — this is the friendly pre-check, mirroring the web hook's behavior.
import { MAX_IMAGES_PER_MESSAGE, type MessageImage } from "@pinomad/protocol/images.ts";

/** Anything prepareImage can read: a file/photo URI or a data URI. */
export type ImageSource = { uri: string; width?: number; height?: number };

export interface AttachmentState {
  readonly images: readonly MessageImage[];
  readonly pending: boolean;
  readonly error: string | null;
}

export interface AttachmentStore {
  readonly state: AttachmentState;
  /** Staged + in-flight against the cap; the picker limit uses this. */
  readonly freeSlots: number;
  subscribe(listener: () => void): () => void;
  add(sources: ImageSource[]): void;
  remove(index: number): void;
  clear(): void;
  /** Surface a problem that never reached add() (e.g. empty clipboard). */
  report(message: string): void;
}

export function createAttachmentStore(options: {
  accepts(): boolean;
  prepare(source: ImageSource): Promise<MessageImage>;
}): AttachmentStore {
  const { accepts, prepare } = options;
  let images: MessageImage[] = [];
  let preparing = 0;
  let error: string | null = null;
  // Bumps on clear() so an in-flight prepare can't resurrect a sent image.
  let generation = 0;
  // Staged + in-flight slots, reserved synchronously: two add() calls before a
  // notify would otherwise both see the same free room and the completion
  // would drop the overflow without telling the user.
  let taken = 0;
  const listeners = new Set<() => void>();
  // Cached snapshot: useSyncExternalStore compares by identity.
  let state: AttachmentState = { images, pending: false, error };

  const emit = (): void => {
    state = { images, pending: preparing > 0, error };
    for (const listener of listeners) listener();
  };

  return {
    get state() {
      return state;
    },
    get freeSlots() {
      return Math.max(0, MAX_IMAGES_PER_MESSAGE - taken);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(sources) {
      if (!accepts()) {
        error = "This model doesn't accept images";
        emit();
        return;
      }
      const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - taken);
      const kept = sources.slice(0, room);
      error = sources.length > room ? `At most ${MAX_IMAGES_PER_MESSAGE} images per message` : null;
      if (kept.length === 0) {
        emit();
        return;
      }
      taken += kept.length;
      // Promise.all keeps source order; a source that fails drops the batch
      // with its error, rather than silently attaching a partial selection.
      const gen = generation;
      preparing += kept.length;
      emit();
      void Promise.all(kept.map((src) => prepare(src))).then(
        (prepared) => {
          // Reserved slots move preparing → staged; the count stays taken.
          if (generation !== gen) return;
          images = [...images, ...prepared];
          preparing -= kept.length;
          emit();
        },
        (failure: unknown) => {
          if (generation !== gen) return;
          taken -= kept.length;
          error = failure instanceof Error ? failure.message : String(failure);
          preparing -= kept.length;
          emit();
        },
      );
    },
    remove(index) {
      taken -= 1;
      images = images.filter((_, i) => i !== index);
      emit();
    },
    clear() {
      generation += 1;
      taken = 0;
      images = [];
      preparing = 0;
      error = null;
      emit();
    },
    report(message) {
      error = message;
      emit();
    },
  };
}
