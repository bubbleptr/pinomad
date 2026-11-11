import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

import { overlayClassName } from "@/shared/ui/dialog"
import { IconButton } from "@/shared/ui/icon-button"
import { Cancel } from "@/shared/ui/icons"

/**
 * A panel that slides in from the start edge over a dimmed page: the phone
 * navigation drawer. It is a Base UI dialog, so a dialog or menu opened from
 * inside it stacks above it, and Escape closes only the topmost layer.
 */
function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

/**
 * The panel: `header` and a close button (named `closeLabel`) in a 48px top
 * row, then `children` in a padded scrolling body. Up to 320px wide. Name it
 * with `aria-label`.
 */
function SheetContent({
  className,
  children,
  header,
  closeLabel = "Close",
  ...props
}: SheetPrimitive.Popup.Props & {
  header?: React.ReactNode
  closeLabel?: string
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        data-slot="sheet-overlay"
        className={cn(
          overlayClassName,
          "transition-opacity duration-300 ease-(--ease-standard) data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:duration-0",
        )}
      />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 start-0 z-50 flex w-screen max-w-80 flex-col overflow-hidden overscroll-contain border-e border-border bg-background text-foreground outline-none",
          "transition-transform duration-300 ease-(--ease-standard) data-ending-style:-translate-x-full data-starting-style:-translate-x-full motion-reduce:duration-0",
          className
        )}
        {...props}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-2">
          {header}
          <SheetPrimitive.Close render={<IconButton label={closeLabel} icon={<Cancel aria-hidden="true" />} />} />
        </div>
        <div className="min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain p-2">
          {children}
        </div>
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  )
}

export { Sheet, SheetContent }
