// A message's image blocks as thumbnails; a click opens the lightbox gallery
// at that image. Bytes render immediately; refs load near the viewport and
// the lightbox only fetches the image it is showing.
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useState } from "react";
import type { ViewImage } from "@pinomad/protocol/images.ts";
import { cachedImageSrc, useImageSrc, useNearViewport } from "./image-source.tsx";

export function MessageImages({ images }: { images: readonly ViewImage[] }) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid="message-images">
      {images.map((image, index) => (
        <MessageThumbnail
          key={index}
          image={image}
          index={index}
          onOpen={() => setOpen(index)}
        />
      ))}
      {open === undefined ? null : (
        <MessageLightbox
          images={images}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}

function MessageThumbnail({
  image,
  index,
  onOpen,
}: {
  image: ViewImage;
  index: number;
  onOpen: () => void;
}) {
  const [observe, visible] = useNearViewport<HTMLDivElement>();
  const state = useImageSrc(image, visible);
  return (
    <div ref={observe}>
      <Thumbnail
        src={state.status === "ready" ? state.src : undefined}
        isLoading={state.status === "loading"}
        alt={`Image ${index + 1}`}
        onClick={onOpen}
      />
    </div>
  );
}

function MessageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: readonly ViewImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  // Only the shown image may fetch. The others use bytes already in memory,
  // so opening a gallery costs one request even when it holds several refs.
  const current = images[index];
  const shown = useImageSrc(current, true);
  const media = images.map((image, itemIndex) => ({
    src: itemIndex === index ? (shown.status === "ready" ? shown.src : "") : (cachedImageSrc(image) ?? ""),
    alt: `Image ${itemIndex + 1}`,
  }));
  return (
    <Lightbox
      isOpen
      media={media}
      index={index}
      onIndexChange={onIndexChange}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    />
  );
}
