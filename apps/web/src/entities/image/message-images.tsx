// A message's image blocks as thumbnails; a click opens the lightbox gallery
// at that image. Bytes render immediately; refs load near the viewport and
// the lightbox only fetches the image it is showing.
import { Button } from "../../shared/ui/button.tsx";
import { Lightbox } from "@/shared/ui/lightbox";
import { Thumbnail } from "@/shared/ui/thumbnail";
import { useToast } from "@/shared/ui/toast";
import { useEffect, useState } from "react";
import type { ViewImage } from "@pinomad/protocol/images.ts";
import { cachedImageSrc, useImageSrc, useNearViewport } from "./image-source.tsx";

export function MessageImages({
  images,
  testId = "message-images",
}: {
  images: readonly ViewImage[];
  testId?: string;
}) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid={testId}>
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
  const state = useImageSrc(image, visible, "thumbnail");
  return (
    <div ref={observe}>
      <Thumbnail
        src={state.status === "ready" ? state.src : undefined}
        loading={state.status === "loading"}
        alt={`Image ${index + 1}`}
        onClick={onOpen}
      />
    </div>
  );
}

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export function MessageLightbox({
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
  const [attempt, setAttempt] = useState(0);
  const current = images[index];
  const shown = useImageSrc(current, true, "original", attempt);
  // A failed original keeps the gallery open on the smaller copy; the toast
  // says so and retries. It goes once the image loads or the gallery closes.
  const toast = useToast();
  const failed = shown.status === "error";
  useEffect(() => {
    if (!failed) return;
    return toast({
      description: "Couldn't load the original image",
      type: "error",
      action: (
        <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      ),
    });
  }, [failed, toast]);
  const shownImages = images.map((image, itemIndex) => ({
    src: itemIndex === index && shown.status === "ready"
      ? shown.src
      : (cachedImageSrc(image, "thumbnail") ?? cachedImageSrc(image, "preview") ?? TRANSPARENT_PIXEL),
    alt: `Image ${itemIndex + 1}`,
  }));
  return (
    <Lightbox
      open
      images={shownImages}
      index={index}
      onIndexChange={onIndexChange}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    />
  );
}
