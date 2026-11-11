import { cn } from "cn";
import type { ComponentProps, ReactElement } from "react";

// Ring diameter and stroke in px: sm 14px overall, md 20px.
const SIZES = { sm: { diameter: 10, stroke: 2 }, md: { diameter: 14, stroke: 3 } } as const;

/** A quarter-and-a-bit arc turning over its track. Announced as "Loading" unless `aria-label` says what loads. */
function Spinner({
  size = "md",
  className,
  "aria-label": label = "Loading",
  ...props
}: Omit<ComponentProps<"span">, "children"> & { size?: keyof typeof SIZES }): ReactElement {
  const { diameter, stroke } = SIZES[size];
  const frame = diameter + stroke * 2;
  const center = frame / 2;
  const circumference = Math.PI * diameter;
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label={label}
      className={cn("inline-grid shrink-0 place-items-center align-middle", className)}
      style={{ width: frame, height: frame }}
      {...props}
    >
      <svg
        width={frame}
        height={frame}
        viewBox={`0 0 ${frame} ${frame}`}
        fill="none"
        aria-hidden="true"
        className="animate-[spin_525ms_linear_infinite] motion-reduce:animate-[spin_3s_linear_infinite]"
      >
        <circle cx={center} cy={center} r={diameter / 2} strokeWidth={stroke} className="stroke-track" />
        {/* From twelve o'clock, clockwise, 135°. */}
        <circle
          cx={center}
          cy={center}
          r={diameter / 2}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.375} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          className="stroke-primary"
        />
      </svg>
    </span>
  );
}

export { Spinner };
