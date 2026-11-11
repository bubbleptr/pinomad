import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "cn"
import { usePortalContainer } from "@/shared/ui/portal-container"

/**
 * The floating surface menus and popovers share: popover fill, 12px corners
 * and a low shadow (with a hairline in dark, where the shadow barely shows).
 * Fades in; closing is instant.
 */
const floatingSurfaceClassName = cn(
  "rounded-[0.75rem] bg-popover text-popover-foreground outline-none",
  "shadow-[0_2px_4px_light-dark(oklch(0_0_0/5%),oklch(0_0_0/25%)),0_4px_8px_light-dark(oklch(0_0_0/10%),oklch(0_0_0/40%)),inset_0_0_0_1px_light-dark(transparent,oklch(1_0_0/8%))]",
  "transition-opacity duration-125 ease-(--ease-standard) data-starting-style:opacity-0 motion-reduce:transition-none",
)

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger {...props} />
}

/** A non-modal dialog by its trigger. Name it with `aria-label`; `className` sets the width. */
function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PopoverPrimitive.Portal container={usePortalContainer()}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        // It scrolls within --available-height, so a tall one stays above or
        // below its trigger instead of jumping beside it.
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            floatingSurfaceClassName,
            "flex max-h-(--available-height) w-72 flex-col overflow-y-auto p-3 text-sm",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { floatingSurfaceClassName, Popover, PopoverContent, PopoverTrigger }
