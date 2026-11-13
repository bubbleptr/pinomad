import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * A surface's first row: 40px like the chat header, so their borders meet.
 * `start` holds the phone dialog's surface switch, `end` the panel's close button.
 */
export function SurfaceBar({
  start,
  end,
  className,
  children,
}: {
  start?: ReactNode;
  end?: ReactNode;
  /** The Terminal surface sets its tab strip on the muted band. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("pinomad-drag flex h-10 shrink-0 items-center gap-1 border-b border-border px-3", className)}>
      {start}
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
      {end}
    </div>
  );
}
