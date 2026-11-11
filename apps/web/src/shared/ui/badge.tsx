import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ComponentProps, ReactElement } from "react";

// A short read-only label beside a row's name: "This device", "Connected",
// "new". One size, 20px, so it sits inside a 20px text line.
const badgeVariants = cva(
  "inline-flex h-5 max-w-full shrink-0 items-center gap-1 overflow-hidden rounded-sm px-2 text-xs/5 font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-default text-foreground",
        success: "bg-success-muted text-success-strong",
        destructive: "bg-destructive-muted text-destructive-strong",
        warning: "bg-orange-muted text-orange-strong",
        muted: "bg-gray-muted text-gray-strong",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, children, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>): ReactElement {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export { Badge };
