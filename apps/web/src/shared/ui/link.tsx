import { cn } from "cn";
import type { ComponentProps } from "react";
import { LinkExternal } from "./icons.tsx";

/**
 * A text link in the surrounding text's size. `external` opens it in a new
 * tab, marked with an icon and a note for screen readers.
 */
export function Link({
  external = false,
  className,
  children,
  ...props
}: ComponentProps<"a"> & { external?: boolean }) {
  return (
    <a
      className={cn(
        "inline-flex items-center gap-0.5 text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        className,
      )}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...props}
    >
      {children}
      {external ? (
        <>
          <LinkExternal aria-hidden="true" className="size-3" />
          <span className="sr-only">(opens in new tab)</span>
        </>
      ) : null}
    </a>
  );
}
