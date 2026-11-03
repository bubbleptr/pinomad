import type { ReactNode } from "react";

/**
 * A surface's first row: 40px like the chat header, so their borders meet.
 * `start` and `end` hold the phone dialog's surface switch and close button.
 */
export function SurfaceBar({ start, end, children }: { start?: ReactNode; end?: ReactNode; children: ReactNode }) {
  return (
    <div className="pinomad-drag flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
      {start}
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
      {end}
    </div>
  );
}
