// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Spinner/Spinner.tsx (MIT). Astryx
// paints the ring on a canvas from resolved theme colors; an SVG stroke reads
// the same tokens from CSS and follows the theme without a repaint.

import { cn } from "cn";

const SIZES = {
  sm: { diameter: 10, border: 2 },
  md: { diameter: 14, border: 3 },
} as const;

/** How much of the circle the active arc covers: Astryx draws 1.5π to 0.25π. */
const SPREAD = 0.375;

const shades = {
  default: "text-[var(--color-accent)]",
  subtle: "text-[var(--color-text-secondary)]",
} as const;

export function ChatSpinner({
  size = "md",
  shade = "default",
  className,
}: {
  size?: keyof typeof SIZES;
  shade?: keyof typeof shades;
  className?: string;
}) {
  const { diameter, border } = SIZES[size];
  const frame = diameter + border * 2;
  const radius = diameter / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-grid place-items-center overflow-hidden align-middle", shades[shade], className)}
      style={{ width: frame, height: frame }}
    >
      <svg
        width={frame}
        height={frame}
        viewBox={`0 0 ${frame} ${frame}`}
        className="block animate-spin [animation-duration:525ms] [backface-visibility:hidden] will-change-transform motion-reduce:[animation-duration:3s]"
        aria-hidden="true"
      >
        <circle
          cx={frame / 2}
          cy={frame / 2}
          r={radius}
          fill="none"
          strokeWidth={border}
          className="[stroke:light-dark(#CCD3DB,#5A5E66)]"
        />
        <circle
          cx={frame / 2}
          cy={frame / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={border}
          strokeLinecap="round"
          strokeDasharray={`${SPREAD * circumference} ${circumference}`}
          transform={`rotate(-90 ${frame / 2} ${frame / 2})`}
        />
      </svg>
    </span>
  );
}
