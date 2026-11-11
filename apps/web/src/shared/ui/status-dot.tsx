import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const statusDotVariants = cva("inline-block size-2 shrink-0 rounded-full", {
  variants: {
    variant: {
      success: "bg-dot-success",
      warning: "bg-dot-warning",
      error: "bg-dot-error",
      neutral: "bg-muted-foreground",
    },
    pulsing: { true: "animate-pulse motion-reduce:animate-none" },
  },
});

type StatusDotVariant = NonNullable<VariantProps<typeof statusDotVariants>["variant"]>;

/**
 * An 8px state light: online, running, waiting, failed. `label` is what a
 * screen reader hears; `tooltip` also shows it on hover. Pulses while
 * something is in progress.
 */
function StatusDot({
  variant,
  label,
  pulsing = false,
  tooltip,
  className,
}: {
  variant: StatusDotVariant;
  label: string;
  pulsing?: boolean;
  tooltip?: string;
  className?: string;
}): ReactElement {
  const dot = (
    <span data-slot="status-dot" role="img" aria-label={label} className={cn(statusDotVariants({ variant, pulsing }), className)} />
  );
  if (tooltip === undefined) return dot;
  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { StatusDot, type StatusDotVariant };
