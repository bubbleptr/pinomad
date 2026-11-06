import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

/**
 * Shimmer for short loading text ("Thinking…", "Running…"). The colours and
 * the parked highlight live in chat.css; the sweep runs here because it moves
 * at one speed whatever the text's length. CSS keyframes only know
 * percentages of the box, so a fixed duration swept a long row several times
 * faster than a short one; each sweep's duration is its own width over the
 * speed, then a fixed rest.
 */
export type TextShimmerProps = ComponentProps<"span"> & {
  children: ReactNode;
};

const SPEED_EM_PER_S = 8;
/** The highlight's width: chat.css sizes and parks the layer by the same value. */
const BAND_EM = 2.6;
const REST_MS = 1600;
const EASING = "cubic-bezier(0.45, 0, 0.55, 1)";

export function TextShimmer({ children, className = "", ...rest }: TextShimmerProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;

    if (
      !element ||
      typeof element.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let animation: Pick<Animation, "cancel"> | undefined;
    let width: number | undefined;

    // Restart only when the width changes: the observer also reports the
    // first layout, and a restart mid-sweep would snap the highlight back.
    const sweep = () => {
      const next = element.getBoundingClientRect().width;

      if (next === width) {
        return;
      }
      width = next;
      animation?.cancel();

      const em = Number.parseFloat(getComputedStyle(element).fontSize) || 16;
      const band = BAND_EM * em;
      const sweepMs = ((width + band) / (SPEED_EM_PER_S * em)) * 1000;
      const duration = sweepMs + REST_MS;
      const parked = `${-band}px 0, 0 0`;
      const past = `${width}px 0, 0 0`;

      animation = element.animate(
        [
          { backgroundPosition: parked, easing: EASING },
          { backgroundPosition: past, offset: sweepMs / duration },
          { backgroundPosition: past },
        ],
        { duration, iterations: Infinity },
      );
    };

    sweep();
    const observer = new ResizeObserver(sweep);
    observer.observe(element);

    return () => {
      observer.disconnect();
      animation?.cancel();
    };
  }, []);

  return (
    <span ref={ref} className={`text-shimmer ${className}`.trim()} data-slot="text-shimmer" {...rest}>
      {children}
    </span>
  );
}
