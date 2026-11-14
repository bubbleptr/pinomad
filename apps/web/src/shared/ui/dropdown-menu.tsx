import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "cn"

import { Check, ChevronRight } from "@/shared/ui/icons"
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

/** A one-of-many choice: the picked row is checked at the end. Closes the menu on pick. */
function DropdownMenuRadioItem({ className, children, closeOnClick = true, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItemClassName, "pe-8", className)}
      closeOnClick={closeOnClick}
      {...props}
    >
      {children}
      <MenuPrimitive.RadioItemIndicator className="absolute end-2 flex items-center">
        <Check aria-hidden="true" className="size-4 text-foreground" />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

/** A muted heading over a group of rows. */
function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn("px-2 pt-1.5 pb-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("mx-2 my-1 h-px shrink-0 bg-border", className)} {...props} />
}

/** A row that opens a second-level menu beside it: a trailing chevron, highlighted while its menu is open. */
function DropdownMenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(menuItemClassName, "data-popup-open:overlay-hover", className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-[inherit]">{children}</span>
      <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

/** The second-level menu, beside its row. */
function DropdownMenuSubContent({ sideOffset = 2, ...props }: Parameters<typeof DropdownMenuContent>[0]) {
  return <DropdownMenuContent side="inline-end" align="start" alignOffset={-4} sideOffset={sideOffset} {...props} />
}

const DropdownMenuSub = MenuPrimitive.SubmenuRoot
const DropdownMenuGroup = MenuPrimitive.Group
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

export {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  menuItemClassName,
  menuPopupClassName,
}
