// Composer attachment state: which images are staged, preparation progress,
// and the last problem the user hit. The host enforces the same limits — this
// is the friendly pre-check.
import { useRef, useState } from "react";
import { MAX_IMAGES_PER_MESSAGE, type MessageImage } from "@pinomad/protocol/images.ts";
import { prepareImage } from "./prepare-image.ts";

export function useImageAttachments(accepts: boolean): {
  readonly images: readonly MessageImage[];
  readonly pending: boolean;
  readonly error: string | null;
  add(files: File[]): void;
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

  const add = (files: File[]): void => {
    if (!acceptsRef.current) {
      setError("This model doesn't accept images");
      return;
    }
    const usable = files.filter((file) => file.type.startsWith("image/"));
    if (usable.length < files.length) setError("Only images can be attached");
    const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - images.length - preparing);
    const kept = usable.slice(0, room);
    if (usable.length > room) setError("At most 4 images per message");
    else if (usable.length === files.length) setError(null);
    if (kept.length === 0) return;
    // Promise.all keeps file order; a file that fails drops the batch with
    // its error, rather than silently attaching a partial selection.
    const gen = generation.current;
    setPreparing((count) => count + kept.length);
    void Promise.all(kept.map((file) => prepareImage(file))).then(
      (prepared) => {
        if (generation.current !== gen) return;
        setImages((current) => [...current, ...prepared].slice(0, MAX_IMAGES_PER_MESSAGE));
        setPreparing((count) => count - kept.length);
      },
      (failure: unknown) => {
        if (generation.current !== gen) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setPreparing((count) => count - kept.length);
      },
    );
  };

  const remove = (index: number): void => {
    setImages((current) => current.filter((_, i) => i !== index));
  };

  const clear = (): void => {
    generation.current += 1;
    setImages([]);
    setPreparing(0);
    setError(null);
  };

  return { images, pending: preparing > 0, error, add, remove, clear };
}
