import { cn } from "cn";
import type { ComponentProps, ReactElement } from "react";

/**
 * A placeholder block for content still loading. Size and radius come from
 * `className`. It waits a second before fading in and out, so a fast load
 * never flashes it; `index` staggers a group by 100ms each.
 */
function Skeleton({ className, index = 0, style, ...props }: ComponentProps<"div"> & { index?: number }): ReactElement {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "rounded-[calc(var(--radius)+2px)] bg-skeleton opacity-25 animate-skeleton motion-reduce:animate-none contrast-more:bg-[color-mix(in_srgb,var(--skeleton),var(--foreground)_30%)] forced-colors:bg-[GrayText] forced-colors:opacity-100",
        className,
      )}
      style={{ animationDelay: `${1000 + 100 * index}ms`, ...style }}
      {...props}
    />
  );
}

export { Skeleton };
