import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ComponentProps, ReactElement } from "react";
import { CancelCircle, CheckCircle, Info, TriangleAlert } from "@/shared/ui/icons";

// A persistent status message: a colored wash with the status icon, a title,
// an optional description and optional actions at the end. Each status is a
// wash and the text color that reads on it (tokens.css).
const alertVariants = cva(
  "grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-[calc(var(--radius)+2px)] px-4 py-3 has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto]",
  {
    variants: {
      variant: {
        info: "bg-info-muted text-info-strong",
        success: "bg-success-muted text-success-strong",
        warning: "bg-warning-muted text-warning-strong",
        destructive: "bg-destructive-muted text-destructive-strong",
      },
    },
  },
);

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

const ICONS = { info: Info, success: CheckCircle, warning: TriangleAlert, destructive: CancelCircle } as const;

/** Problems interrupt (alert); progress and outcomes wait their turn (status). */
const ROLES = { info: "status", success: "status", warning: "alert", destructive: "alert" } as const;

/** Children are `AlertTitle`, then optionally `AlertDescription` and `AlertAction`. */
function Alert({
  className,
  variant,
  children,
  ...props
}: ComponentProps<"div"> & { variant: AlertVariant }): ReactElement {
  const Icon = ICONS[variant];
  return (
    <div data-slot="alert" role={ROLES[variant]} className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon aria-hidden="true" className="row-span-2 size-5" />
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="alert-title" className={cn("col-start-2 min-w-0 text-sm/5 font-semibold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="alert-description" className={cn("col-start-2 min-w-0 text-xs/5", className)} {...props} />;
}

/** End-aligned controls such as Retry. Pulled 4px into the padding, so a 28px button sits level with a one-line title. */
function AlertAction({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="alert-action"
      className={cn("col-start-3 row-span-2 row-start-1 -my-1 flex items-center gap-2", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
