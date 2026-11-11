import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "cn";

const STEP = 10;
const LARGE_STEP = 50;
/** Kept from Astryx's useResizable, so widths saved before ADR-0048 still load. */
const STORAGE_PREFIX = "astryx-resizable:";

const clamp = (size: number, min: number, max: number): number => Math.min(max, Math.max(min, size));

function loadWidth(id: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + id) ?? "null");
    return typeof parsed === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ResizableWidth {
  /** The current width in px, within [min, max] as of the last resize. */
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly resize: (size: number) => void;
}

/**
 * A px width with bounds, saved to localStorage under `autoSaveId`. `max` may
 * change between renders (the room beside a panel); the width is clamped to it
 * on the next resize, so callers that must shrink at once call `resize`.
 */
export function useResizableWidth({
  defaultSize,
  min,
  max,
  autoSaveId,
}: {
  defaultSize: number;
  min: number;
  max: number;
  autoSaveId: string;
}): ResizableWidth {
  const [size, setSize] = useState(() => clamp(loadWidth(autoSaveId) ?? defaultSize, min, max));
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + autoSaveId, JSON.stringify(size));
    } catch {
      // Storage may be unavailable (private mode, quota): the width still applies.
    }
  }, [autoSaveId, size]);
  const resize = useCallback((next: number) => setSize(clamp(next, min, max)), [min, max]);
  return { size, min, max, resize };
}

/**
 * The drag handle on a resizable pane's edge: a `separator` that drags with
 * the pointer and steps with the arrow keys (Shift for larger steps, Home and
 * End for the bounds). It overlays the pane's end edge; `reversed` is for a
 * pane on the right, which grows as the pointer moves left. No grip shows
 * except under keyboard focus: the pane edges already mark where to drag.
 */
export function ResizeHandle({
  width,
  label,
  reversed = false,
  className,
}: {
  width: ResizableWidth;
  label: string;
  reversed?: boolean;
  className?: string;
}) {
  const { size, min, max, resize } = width;
  const sign = reversed ? -1 : 1;
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startSize = size;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
    const move = (moved: globalThis.PointerEvent): void => resize(startSize + (moved.clientX - startX) * rtl * sign);
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      stopDrag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    stopDrag.current = stop;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? LARGE_STEP : STEP;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
    const next =
      event.key === "ArrowRight" ? size + step * rtl * sign
      : event.key === "ArrowLeft" ? size - step * rtl * sign
      : event.key === "Home" ? min
      : event.key === "End" ? max
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-slot="resize-handle"
      className={cn(
        "group/resize absolute inset-y-0 end-0 z-2 flex w-4 cursor-col-resize touch-none items-center justify-center outline-none select-none",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary",
        className,
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className="invisible h-8 w-[3px] rounded-full bg-border group-focus-visible/resize:visible"
      />
    </div>
  );
}
