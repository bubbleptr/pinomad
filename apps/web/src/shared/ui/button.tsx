import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ReactElement, ReactNode } from "react";
import { useDialogPortal } from "@/shared/ui/dialog-portal";
import { LoaderCircle } from "@/shared/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

// The four tiers and when to use each are in apps/web/DESIGN.md. Hover and
// press paint an overlay (styles.css) over the fill, so they work on any fill.

const buttonVariants = cva(
  [
    "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,background-image,box-shadow,color,translate] outline-none select-none",
    "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
    "active:not-aria-[haspopup]:not-data-[disabled]:translate-y-px",
    "disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground not-data-[disabled]:hover:bg-primary/85",
        // Surface fill, hairline and a 1px drop, so a standalone action looks
        // pressable beside a field and on the dark surface. The surface is
        // Astryx's name because its dialogs shift it a step up.
        secondary: [
          "bg-(--color-background-surface) text-foreground",
          "shadow-[inset_0_0_0_1px_var(--border),0_1px_2px_light-dark(oklch(0_0_0/6%),oklch(0_0_0/30%))]",
          "not-data-[disabled]:hover:overlay-hover not-data-[disabled]:active:overlay-pressed aria-expanded:overlay-hover",
          // Settings is a page of flat rows: keep the hairline, drop the drop
          // (it stood out against the bordered groups) and the fill (a step
          // below the card in dark mode).
          "in-[.pigui-settings]:bg-transparent in-[.pigui-settings]:shadow-[inset_0_0_0_1px_var(--border)]",
        ],
        ghost:
          "bg-transparent text-foreground not-data-[disabled]:hover:overlay-hover not-data-[disabled]:active:overlay-pressed aria-expanded:overlay-hover aria-pressed:overlay-hover",
        // Text on the red wash needs the darker pair: --destructive alone is
        // about 3.4:1 there.
        destructive: [
          "bg-destructive-muted text-destructive-strong focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
          "not-data-[disabled]:hover:overlay-hover not-data-[disabled]:active:overlay-pressed",
        ],
      },
      size: {
        md: "h-8 gap-1.5 px-3 has-[>svg:first-child]:pl-2.5",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 has-[>svg:first-child]:pl-2",
        icon: "size-8",
        "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner over the label and disables the button; the label keeps its width and stays the accessible name. */
    loading?: boolean;
    /** Shown on hover and focus. A disabled button with a tooltip stays focusable so keyboard users can reach it. */
    tooltip?: ReactNode;
  };

function Button({
  className,
  variant,
  size,
  loading = false,
  tooltip,
  disabled = false,
  type = "button",
  children,
  ...props
}: ButtonProps): ReactElement {
  const inactive = disabled || loading;
  const [portalRef, container] = useDialogPortal();
  const button = (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant ?? "secondary"}
      data-size={size ?? "md"}
      type={type}
      disabled={inactive}
      focusableWhenDisabled={tooltip != null && inactive}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? (
        <>
          {/* Transparent, not hidden: the label keeps the width and the accessible name. */}
          <span className="inline-flex items-center gap-[inherit] opacity-0">{children}</span>
          <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
            <LoaderCircle className="animate-spin" />
          </span>
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  );
  if (tooltip == null) return button;
  return (
    <Tooltip>
      <TooltipTrigger ref={portalRef} render={button} />
      <TooltipContent container={container}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { Button, buttonVariants, type ButtonProps };
