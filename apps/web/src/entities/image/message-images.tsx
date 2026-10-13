// A message's image blocks as thumbnails; a click opens the lightbox gallery
// at that image. The composer drawer reuses the same data-URL form for staged
// attachments.
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useState } from "react";
import type { MessageImage } from "@pinomad/protocol/images.ts";

export const imageSrc = (image: MessageImage): string => `data:${image.mimeType};base64,${image.data}`;

export function MessageImages({ images }: { images: readonly MessageImage[] }) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid="message-images">
      {images.map((image, index) => (
        <Thumbnail
          key={index}
          src={imageSrc(image)}
          alt={`Image ${index + 1}`}
          onClick={() => setOpen(index)}
        />
      ))}
      {open === undefined ? null : (
        <Lightbox
          isOpen
          media={images.map((image, index) => ({ src: imageSrc(image), alt: `Image ${index + 1}` }))}
          index={open}
          onIndexChange={setOpen}
          onOpenChange={(next) => {
            if (!next) setOpen(undefined);
          }}
        />
      )}
    </div>
  );
}
