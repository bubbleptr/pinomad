// Composer attachment state: which images are staged, preparation progress,
// and the last problem the user hit. The host enforces the same limits — this
// is the friendly pre-check. A host-scoped slot keeps the tray alive while
// focus moves to another host.
import { useRef } from "react";
import type { MessageImage } from "@pinomad/protocol/images.ts";
import {
  useComposerSlotState,
  useLocalComposerSlot,
} from "../composer/composer-context.tsx";
import type { ComposerSlot } from "../composer/composer-store.ts";

export function useImageAttachments(accepts: boolean, slot?: ComposerSlot): {
  readonly images: readonly MessageImage[];
  readonly pending: boolean;
  readonly error: string | null;
  add(files: File[]): void;
  /** Replace the staged images with already-prepared ones, as an Edit does. */
  restore(images: readonly MessageImage[]): void;
  remove(index: number): void;
  clear(): void;
} {
  const local = useLocalComposerSlot();
  const active = slot ?? local;
  const state = useComposerSlotState(active);
  // The composer re-picks its model without remounting; add() may run between.
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  return {
    images: state.images,
    pending: state.preparing > 0,
    error: state.imageError,
    add: (files) => active.addImages(files, acceptsRef.current),
    restore: (images) => active.restoreImages(images),
    remove: (index) => active.removeImage(index),
    clear: () => active.clearImages(),
  };
}
