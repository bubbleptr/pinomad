import type { ReactNode, SVGProps } from "react";
import { cn } from "cn";

// The glyphs Astryx's neutral theme resolved for the chat components, as
// Lucide draws them (ISC, see docs/licenses/lucide.md): 24-unit grid, 2px
// round stroke, sized by the em box like the theme's registry icons.
const paths = {
  arrowUp: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  stop: <rect width="18" height="18" x="3" y="3" rx="2" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  warning: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  checkDouble: (
    <>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
  ),
} satisfies Record<string, ReactNode>;

export type ChatKitIconName = keyof typeof paths;

/** A bare 1em glyph, for slots that size it (the button's icon box). */
export function ChatKitGlyph({ name, ...props }: { name: ChatKitIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

const iconSizes = {
  xsm: "size-3 text-[0.75rem]",
  sm: "size-4 text-[1rem]",
  md: "size-5 text-[1.25rem]",
} as const;

/**
 * Astryx `<Icon icon="…" size="…" />`: an inline-flex box that sets the
 * glyph's em size. Decorative unless `label` is given.
 */
export function ChatKitIcon({
  name,
  size,
  label,
  className,
}: {
  name: ChatKitIconName;
  size: keyof typeof iconSizes;
  label?: string;
  className?: string;
}) {
  return (
    <span
      {...(label === undefined ? { "aria-hidden": "true" as const } : { role: "img", "aria-label": label })}
      className={cn("inline-flex shrink-0 items-center justify-center", iconSizes[size], className)}
    >
      <ChatKitGlyph name={name} />
    </span>
  );
}
