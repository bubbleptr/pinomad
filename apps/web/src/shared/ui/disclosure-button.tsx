import type { ComponentProps } from "react";
import { cn } from "cn";
import { ChevronRight } from "@/shared/ui/icons";

type DisclosureButtonProps = ComponentProps<"button"> & {
  /** Whether the region this button folds is showing. */
  open: boolean;
};

/**
 * The header that folds and unfolds the region under it: it carries
 * `aria-expanded` and the focus ring, and turns the `DisclosureChevron` placed
 * inside it. Layout, hover and the label are the caller's; pass
 * `aria-controls` with the region's id. For a full-width row with the chevron
 * at the end over a Base UI panel, use `CollapsibleTrigger`.
 */
function DisclosureButton({ open, className, type = "button", ...props }: DisclosureButtonProps) {
  return (
    <button
      type={type}
      data-slot="disclosure-button"
      aria-expanded={open}
      className={cn("group/disclosure outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}
      {...props}
    />
  );
}

/** Points right while the region is folded and down while it shows. */
function DisclosureChevron({ className, ...props }: ComponentProps<typeof ChevronRight>) {
  return (
    <ChevronRight
      aria-hidden="true"
      data-slot="disclosure-chevron"
      className={cn(
        "size-3.5 shrink-0 transition-transform duration-150 ease-out group-aria-expanded/disclosure:rotate-90 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { DisclosureButton, DisclosureChevron, type DisclosureButtonProps };
