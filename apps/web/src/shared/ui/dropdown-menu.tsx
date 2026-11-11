import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "cn"

import { floatingSurfaceClassName } from "@/shared/ui/popover"

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

/** Render the button through `render` (`render={<IconButton … />}`) so it keeps its look and name. */
function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger {...props} />
}

// Shared with the context menu.
const menuPopupClassName = cn(
  floatingSurfaceClassName,
  "flex max-h-[min(300px,var(--available-height))] min-w-(--anchor-width) flex-col gap-0.5 overflow-y-auto p-1",
)

const menuItemClassName = cn(
  "relative flex min-h-7 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm/5 outline-hidden select-none",
  "data-highlighted:overlay-hover data-disabled:cursor-not-allowed data-disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
)

/** As wide as its longest item, at least the trigger's width; `className` can set a width. */
function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(menuPopupClassName, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** A row: an optional leading icon, then the label. A disabled row stays focusable and announced. */
function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(menuItemClassName, className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  menuItemClassName,
  menuPopupClassName,
}
