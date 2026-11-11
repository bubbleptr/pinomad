// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Badge/Badge.tsx (MIT), with the
// neutral theme's variant colors: the pill the composer's tokens and the
// drawer's count render as.

import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "cn";
import { themeProps } from "./theme-props";

const variants = {
  neutral: "bg-[light-dark(#e5e5e5,var(--color-neutral))] text-[light-dark(#262626,#e5e5e5)]",
  info: "bg-[light-dark(#0074e2,#6d9cfe)] text-[light-dark(#ffffff,#171717)]",
  success: "bg-[light-dark(#198100,#64af4c)] text-[light-dark(#ffffff,#171717)]",
  warning: "bg-[#ffce2f] text-[#171717]",
  error: "bg-[light-dark(#e33f4a,#ff705d)] text-[light-dark(#ffffff,#171717)]",
} as const;

// The colored, non-semantic Astryx variants (blue, purple…) are not ported:
// nothing in the app renders them.

export type ChatBadgeVariant = keyof typeof variants;

export type ChatBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  ref?: Ref<HTMLSpanElement>;
  variant?: ChatBadgeVariant;
  label: ReactNode;
  icon?: ReactNode;
};

export function ChatBadge({ ref, variant = "neutral", label, icon, className, ...props }: ChatBadgeProps) {
  const theme = themeProps("badge", { variant });
  return (
    <span
      ref={ref}
      {...theme}
      className={cn(
        theme.className,
        "inline-flex h-5 items-center justify-center gap-1 rounded-full px-2 py-0 [font-family:inherit] text-[length:var(--font-size-sm)] leading-[1.6667] font-medium whitespace-nowrap",
        variants[variant],
        className,
      )}
      {...props}
    >
      {icon}
      {label}
    </span>
  );
}
