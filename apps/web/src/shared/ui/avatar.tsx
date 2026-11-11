import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ReactElement } from "react";

// Initials are 40% of the circle.
const avatarVariants = cva("relative flex shrink-0 overflow-hidden rounded-full select-none", {
  variants: {
    size: {
      xs: "size-5 text-[8px]",
      lg: "size-12 text-[19.2px]",
    },
  },
  defaultVariants: { size: "lg" },
});

/** First letters of the first and last word: "Ada Lovelace" → "AL", "kieran@example.com" → "K". */
function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.charAt(0) ?? "";
  return (words.length > 1 ? first + words[words.length - 1]!.charAt(0) : first).toUpperCase();
}

/**
 * A person's circle with their initials in `AvatarFallback`. The root is
 * the image the screen reader names, so pass `aria-label`.
 */
function Avatar({ className, size, ...props }: AvatarPrimitive.Root.Props & VariantProps<typeof avatarVariants>): ReactElement {
  return <AvatarPrimitive.Root data-slot="avatar" role="img" className={cn(avatarVariants({ size }), className)} {...props} />;
}

function AvatarFallback({ className, ...props }: AvatarPrimitive.Fallback.Props): ReactElement {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn("flex size-full items-center justify-center bg-default font-medium text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export { Avatar, AvatarFallback, initials };
