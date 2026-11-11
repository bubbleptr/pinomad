import { cn } from "cn";
import { useState, type ReactElement } from "react";
import { Cancel, ImageIcon } from "@/shared/ui/icons";
import { Skeleton } from "@/shared/ui/skeleton";
import { Spinner } from "@/shared/ui/spinner";

/**
 * A 64px square image preview: a staged attachment or an image in a message.
 * The group is named by `alt`. `onClick` turns the image into an "Open …"
 * button; `onRemove` adds a "Remove …" button in the corner, shown on hover
 * or focus (always on touch screens). While `loading`, a placeholder stands
 * in for a missing `src` and a spinner covers a present one.
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

  const image = (
    <>
      {showImage ? (
        <img src={src} alt={alt} onError={() => setErroredSrc(src)} className="block size-full object-cover" />
      ) : loading ? (
        <Skeleton className="size-full rounded-none" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <ImageIcon aria-hidden="true" className="size-6" />
        </span>
      )}
    </>
  );

  return (
    <div
      data-slot="thumbnail"
      role="group"
      aria-label={alt}
      className={cn("group/thumbnail relative isolate inline-flex w-16 shrink-0 flex-col", className)}
    >
      {/* The open button's focus ring is drawn here: this box clips its children. */}
      <div className="relative aspect-square w-full overflow-hidden rounded-[var(--radius-element)] bg-default has-[>button:first-child:focus-visible]:outline-2 has-[>button:first-child:focus-visible]:outline-offset-2 has-[>button:first-child:focus-visible]:outline-primary has-[>button:first-child:focus-visible]:outline-solid">
        {interactive ? (
          <button
            type="button"
            onClick={onClick}
            aria-label={`Open ${alt}`}
            className="block size-full cursor-pointer overflow-hidden rounded-[inherit] outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:transition-colors after:duration-150 active:after:bg-black/10 [@media(hover:hover)]:hover:after:bg-surface-hover"
          >
            {image}
          </button>
        ) : (
          image
        )}
        {showImage ? (
          <div className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--border)]" />
        ) : null}
        {loading && showImage ? (
          <div className="absolute inset-0 z-1 flex items-center justify-center bg-black/50">
            <Spinner size="sm" />
          </div>
        ) : null}
        {onRemove === undefined ? null : (
          <button
            type="button"
            aria-label={`Remove ${alt}`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="absolute end-1 top-1 z-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-[calc(var(--radius-element)-4px)] bg-black/50 text-white opacity-0 transition-opacity duration-150 outline-none group-hover/thumbnail:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-primary group-focus-within/thumbnail:opacity-100 pointer-coarse:opacity-100 dark:bg-black/80"
          >
            <Cancel aria-hidden="true" className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export { Thumbnail };
