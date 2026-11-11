import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { cn } from "cn"

import { ChevronDown } from "@/shared/ui/icons"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

/**
 * A full-width disclosure row: the children on the left, a chevron on the
 * right that turns over while the panel is open. The children set their own
 * type (usually `text-xs/5 text-muted-foreground`).
 */
function CollapsibleTrigger({ className, children, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-2 text-start outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary",
        className
      )}
      {...props}
    >
      {/* Trimmed to the cap height, so the row is only as tall as the chevron. */}
      <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
      <ChevronDown
        aria-hidden="true"
        className="size-[1.0625rem] shrink-0 text-muted-foreground transition-transform duration-150 ease-out [[data-panel-open]>&]:rotate-180"
      />
    </CollapsiblePrimitive.Trigger>
  )
}

function CollapsibleContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn("pt-1 text-sm/5", className)}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
