import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { cn } from "cn"

import { menuItemClassName, menuPopupClassName } from "@/shared/ui/dropdown-menu"
import { usePortalContainer } from "@/shared/ui/portal-container"

/** Opens on right click or a long press over its trigger; `disabled` turns both off. */
function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      // No iOS callout or text selection on the long press that opens the menu.
      className={cn("[-webkit-touch-callout:none]", className)}
      {...props}
    />
  )
}

/**
 * Opens at the pointer. `anchor` overrides that, for a menu opened from the
 * keyboard (the menu key, Shift+F10), whose event has no pointer position.
 */
function ContextMenuContent({
  className,
  anchor,
  ...props
}: ContextMenuPrimitive.Popup.Props & Pick<ContextMenuPrimitive.Positioner.Props, "anchor">) {
  return (
    <ContextMenuPrimitive.Portal container={usePortalContainer()}>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none" side="bottom" align="start" anchor={anchor}>
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(menuPopupClassName, "min-w-40", className)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, ...props }: ContextMenuPrimitive.Item.Props) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(menuItemClassName, className)}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-0.5 h-px shrink-0 bg-border", className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
}
