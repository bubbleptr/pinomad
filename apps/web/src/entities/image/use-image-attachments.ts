// Composer attachment state: which images are staged, preparation progress,
// and the last problem the user hit. The host enforces the same limits — this
// is the friendly pre-check.
import { useRef, useState } from "react";
import { MAX_IMAGES_PER_MESSAGE, type MessageImage } from "@pinomad/protocol/images.ts";
import { primeImages } from "./image-cache.ts";
import { prepareImage } from "./prepare-image.ts";

export function useImageAttachments(accepts: boolean): {
  readonly images: readonly MessageImage[];
  readonly pending: boolean;
  readonly error: string | null;
  add(files: File[]): void;
  /** Replace the staged images with already-prepared ones, as an Edit does. */
  restore(images: readonly MessageImage[]): void;
  remove(index: number): void;
  clear(): void;
} {
  const [images, setImages] = useState<MessageImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The composer re-picks its model without remounting; add() may run between.
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  // Bumps on clear() so an in-flight prepare can't resurrect a sent image.
  const generation = useRef(0);
  // Staged + in-flight slots, reserved synchronously: two add() calls before a
  // re-render would otherwise both see the same free room and the completion
  // would drop the overflow without telling the user.
  const taken = useRef(0);

  const add = (files: File[]): void => {
    if (!acceptsRef.current) {
      setError("This model doesn't accept images");
      return;
    }
    const usable = files.filter((file) => file.type.startsWith("image/"));
    if (usable.length < files.length) setError("Only images can be attached");
    const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - taken.current);
    const kept = usable.slice(0, room);
    if (usable.length > room) setError("At most 4 images per message");
    else if (usable.length === files.length) setError(null);
    if (kept.length === 0) return;
    taken.current += kept.length;
    // Promise.all keeps file order; a file that fails drops the batch with
    // its error, rather than silently attaching a partial selection.
    const gen = generation.current;
    setPreparing((count) => count + kept.length);
    void Promise.all(kept.map((file) => prepareImage(file))).then(
      async (prepared) => {
        // Reserve the refs before the image becomes sendable. Submit can then
        // run synchronously, keeping click order in the controller's queue,
        // while the first snapshot resolves from memory.
        if (generation.current !== gen) return;
        await primeImages(prepared);
        // Reserved slots move preparing → staged; the count stays taken.
        if (generation.current !== gen) return;
        setImages((current) => [...current, ...prepared]);
        setPreparing((count) => count - kept.length);
      },
      (failure: unknown) => {
        if (generation.current !== gen) return;
        taken.current -= kept.length;
        setError(failure instanceof Error ? failure.message : String(failure));
        setPreparing((count) => count - kept.length);
      },
    );
  };

  // Restoring is not add(): the images were already admitted and prepared, so
  // an edit must not drop them when the model no longer accepts images. The
  // generation bump keeps a prepare still in flight from appending to the set.
  const restore = (next: readonly MessageImage[]): void => {
    const kept = next.slice(0, MAX_IMAGES_PER_MESSAGE);
    generation.current += 1;
    taken.current = kept.length;
    setPreparing(0);
    setImages([...kept]);
    setError(next.length > MAX_IMAGES_PER_MESSAGE ? "At most 4 images per message" : null);
  };

  const remove = (index: number): void => {
    taken.current -= 1;
    setImages((current) => current.filter((_, i) => i !== index));
  };

  const clear = (): void => {
    generation.current += 1;
    taken.current = 0;
    setImages([]);
    setPreparing(0);
    setError(null);
  };

  return { images, pending: preparing > 0, error, add, restore, remove, clear };
}
