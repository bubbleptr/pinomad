import { cn } from "cn";
import { useState, type ReactElement } from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentMedia,
  AttachmentTrigger,
} from "@/shared/ui/attachment";
import { Cancel, ImageIcon } from "@/shared/ui/icons";
import { Skeleton } from "@/shared/ui/skeleton";
import { Spinner } from "@/shared/ui/spinner";

/**
 * A 64px image attachment: a staged image or an image in a message, as an
 * Attachment card with only its media. The group is named by `alt`. `onClick`
 * makes the whole card an "Open …" button; `onRemove` adds a "Remove …"
 * button in the corner, shown on hover or focus (always on touch screens).
 * While `loading`, a placeholder stands in for a missing `src` and a spinner
 * covers a present one.
 */
function Thumbnail({
  src,
  alt,
  loading = false,
  onClick,
  onRemove,
  className,
}: {
  src?: string | undefined;
  alt: string;
  loading?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
}): ReactElement {
  // The exact src that failed, so a new src gets a fresh attempt.
  const [erroredSrc, setErroredSrc] = useState<string | undefined>(undefined);
  const hasSrc = src !== undefined;
  const failed = hasSrc && erroredSrc === src;
  const showImage = hasSrc && !failed;
  const interactive = onClick !== undefined && !loading;

  return (
    <Attachment
      data-slot="thumbnail"
      role="group"
      aria-label={alt}
      orientation="vertical"
      state={loading ? "uploading" : "done"}
      // 64px with a 4px frame: the default vertical card is 96px with 8px.
      className={cn("w-16 rounded-lg has-data-[slot=attachment-media]:p-1", className)}
    >
      <AttachmentMedia variant="image" className="rounded-md">
        {showImage ? (
          <img src={src} alt={alt} onError={() => setErroredSrc(src)} />
        ) : loading ? (
          <Skeleton className="size-full rounded-none" />
        ) : (
          <ImageIcon aria-hidden="true" className="text-muted-foreground" />
        )}
        {loading && showImage ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Spinner size="sm" />
          </div>
        ) : null}
      </AttachmentMedia>
      {interactive ? <AttachmentTrigger aria-label={`Open ${alt}`} className="cursor-pointer" onClick={onClick} /> : null}
      {onRemove === undefined ? null : (
        <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-1.5 group-data-[orientation=vertical]/attachment:right-1.5">
          {/* A dark badge, not the ghost wash: it sits on a photo. */}
          <AttachmentAction
            aria-label={`Remove ${alt}`}
            className="size-5 bg-black/50 text-white opacity-0 group-focus-within/attachment:opacity-100 group-hover/attachment:opacity-100 not-data-[disabled]:hover:bg-black/70 not-data-[disabled]:hover:bg-none focus-visible:opacity-100 pointer-coarse:opacity-100 dark:bg-black/80 [&_svg:not([class*='size-'])]:size-3"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <Cancel aria-hidden="true" />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}

export { Thumbnail };
