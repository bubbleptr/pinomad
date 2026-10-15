// React face of the attachment store: same behavior as the web hook —
// staged images, in-flight count, the last problem, and clear() dropping
// in-flight results so a sent image can't resurrect.
import { useRef, useSyncExternalStore } from "react";
import { createAttachmentStore, type AttachmentStore, type ImageSource } from "./attachment-store.ts";
import { prepareImage } from "./prepare-image.ts";

export function useImageAttachments(accepts: boolean): {
  readonly images: AttachmentStore["state"]["images"];
  readonly pending: boolean;
  readonly error: string | null;
  readonly freeSlots: number;
  add(sources: ImageSource[]): void;
  remove(index: number): void;
  clear(): void;
  report(message: string): void;
} {
  // The composer re-picks its model without remounting; add() may run between.
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const storeRef = useRef<AttachmentStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createAttachmentStore({
      accepts: () => acceptsRef.current,
      prepare: prepareImage,
    });
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.state,
  );
  return {
    images: state.images,
    pending: state.pending,
    error: state.error,
    freeSlots: store.freeSlots,
    add: store.add,
    remove: store.remove,
    clear: store.clear,
    report: store.report,
  };
}
