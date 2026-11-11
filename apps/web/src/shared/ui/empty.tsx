import { cn } from "cn";
import type { ComponentProps, ReactElement } from "react";

// A screen or pane with nothing to show yet, or a state to wait out
// ("Connecting"): a centered title, a line of explanation, optional actions.

/** Announced as a status, so a screen reader hears it replace the content. */
function Empty({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="empty"
      role="status"
      className={cn("flex flex-col items-center justify-center gap-4 px-6 py-8 text-center", className)}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="empty-header" className={cn("flex max-w-[360px] flex-col items-center", className)} {...props} />;
}

function EmptyTitle({ className, ...props }: ComponentProps<"h3">): ReactElement {
  return <h3 data-slot="empty-title" className={cn("text-[1.0625rem]/6 font-semibold", className)} {...props} />;
}

function EmptyDescription({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="empty-description" className={cn("text-sm/5 text-muted-foreground", className)} {...props} />;
}

function EmptyContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="empty-content" className={cn("mt-1 flex items-center gap-2", className)} {...props} />;
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent };
