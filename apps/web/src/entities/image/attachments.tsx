// The composer halves of attachments: the hidden file picker the "+" menu
// opens, and the staged-thumbnail row the prompt input shows in its drawer.
// Shared by the conversation composer and the draft home.
import type { ReactNode, RefObject } from "react";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import type { MessageImage } from "@pinomad/protocol/images.ts";
import { imageSrc } from "./image-url.ts";

export function ImageFileInput({
  inputRef,
  onFiles,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      aria-hidden
      tabIndex={-1}
      onChange={(event) => {
        onFiles([...(event.target.files ?? [])]);
        // Picking the same file twice must fire again.
        event.target.value = "";
      }}
    />
  );
}

/** The staged thumbnails; undefined means "nothing staged" — no drawer. */
export function attachmentDrawer({
  images,
  pending,
  onRemove,
}: {
  images: readonly MessageImage[];
  pending: boolean;
  onRemove: (index: number) => void;
}): ReactNode | undefined {
  if (images.length === 0 && !pending) return undefined;
  return (
    <div className="flex flex-wrap gap-2" data-testid="composer-attachments">
      {images.map((image, index) => (
        <Thumbnail
          key={index}
          src={imageSrc(image)}
          alt={`Image ${index + 1}`}
          onRemove={() => onRemove(index)}
        />
      ))}
      {pending ? <Thumbnail isLoading alt="Preparing image" /> : null}
    </div>
  );
}
