// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Button/Button.tsx (MIT): only the
// variants, sizes and states the chat components render.

import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "cn";

export type ChatActionButtonVariant = "primary" | "secondary" | "ghost";

const variantClasses: Record<ChatActionButtonVariant, string> = {
  primary: "bg-[var(--color-accent)] text-[var(--color-on-accent)]",
  secondary: "bg-[var(--color-neutral)] text-[var(--color-text-primary)]",
  ghost: "bg-transparent text-[var(--color-text-primary)]",
};

export type ChatActionButtonProps = Omit<ComponentProps<"button">, "children"> & {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  variant?: ChatActionButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
  isIconOnly?: boolean;
  isDisabled?: boolean;
  children?: ReactNode;
};

/** Astryx `Button` at the look the chat components used: label, icon, icon-only, disabled. */
export function ChatActionButton({
  ref,
  label,
  variant = "secondary",
  size = "md",
  icon,
  isIconOnly = false,
  isDisabled = false,
  children,
  className,
  onClick,
  type = "button",
  ...props
}: ChatActionButtonProps) {
  const needsAriaLabel = (isIconOnly && label !== "") || (children != null && children !== label);
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-label={needsAriaLabel ? label : undefined}
      {...props}
      onClick={(event) => {
        if (isDisabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(
        "relative inline-flex items-center justify-center gap-2 border-0 px-3 py-2",
        "rounded-[var(--_button-radius,var(--radius-element))] [font-family:inherit] text-[length:var(--font-size-base)] leading-[1.4286] font-medium whitespace-nowrap",
        "cursor-pointer transition-[background-image,background-color,color,opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] motion-reduce:duration-0",
        "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--color-accent)] focus-visible:outline-solid",
        size === "md" ? "h-[var(--size-element-md)]" : "h-[var(--size-element-sm)]",
        variantClasses[variant],
        isIconOnly && "aspect-square p-0",
        isDisabled
          ? "cursor-not-allowed opacity-50"
          : "[transform:scale(1)] hover:[background-image:linear-gradient(var(--color-overlay-hover),var(--color-overlay-hover))] active:[background-image:linear-gradient(var(--color-overlay-pressed),var(--color-overlay-pressed))] active:[transform:scale(0.98)]",
        className,
      )}
    >
      {icon ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-[16px]">{icon}</span>
      ) : null}
      {isIconOnly ? null : <span className="min-w-0 overflow-hidden text-ellipsis">{children ?? label}</span>}
    </button>
  );
}
