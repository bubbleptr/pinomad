import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

import { IconButton } from "@/shared/ui/icon-button"
import { Cancel } from "@/shared/ui/icons"

/**
 * Forms and confirmations pass `disablePointerDismissal`, so a stray click
 * outside can't throw away what was typed; Escape and the close button still
 * close them.
 */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close {...props} />
}

// Shared with the alert dialog and the lightbox.
const overlayClassName =
  "fixed inset-0 isolate z-50 bg-[light-dark(rgb(0_0_0/50%),rgb(0_0_0/80%))] backdrop-blur-[2px]"

const popupClassName = cn(
  // Centred like a native modal <dialog>: inset 0 and auto margins, so the
  // enter animation is free to use translate and scale.
  "fixed inset-0 z-50 m-auto flex h-fit max-h-[75vh] w-[400px] max-w-[90vw] flex-col overflow-hidden rounded-[0.75rem] bg-card text-foreground outline-none",
  "shadow-[0_4px_6px_light-dark(oklch(0_0_0/10%),oklch(0_0_0/50%)),0_12px_24px_light-dark(oklch(0_0_0/15%),oklch(0_0_0/70%)),inset_0_0_0_1px_light-dark(transparent,oklch(1_0_0/15%))]",
  // Rises in; closing is instant. `starting:` (CSS @starting-style) rather
  // than data-starting-style, which Base UI skips for a dialog mounted open.
  "transition-[opacity,translate,scale] duration-250 ease-(--ease-standard) starting:translate-y-4 starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
)

/**
 * Where focus lands on open: a field marked `data-autofocus`, else the
 * title (so a screen reader reads it first, and the close button isn't
 * what Enter presses), else Base UI's first tabbable element.
 */
function initialFocusIn(popup: React.RefObject<HTMLElement | null>) {
  return () =>
    popup.current?.querySelector<HTMLElement>("[data-autofocus]") ??
    popup.current?.querySelector<HTMLElement>("[data-slot=dialog-title], [data-slot=alert-dialog-title]") ??
    true
}

/**
 * The dialog box. `className` sets its width (`w-[480px]`); it is capped at
 * 90vw and 75vh, and the body scrolls. `variant="fullscreen"` fills the
 * viewport with no frame.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  variant = "default",
  ref,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  variant?: "default" | "fullscreen"
}) {
  const popup = React.useRef<HTMLDivElement>(null)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        // Fades in with the popup, on the same timing.
        className={cn(overlayClassName, "transition-opacity duration-250 ease-(--ease-standard) starting:opacity-0 motion-reduce:transition-none")}
      />
      <DialogPrimitive.Popup
        ref={(element: HTMLDivElement | null) => {
          popup.current = element
          if (typeof ref === "function") ref(element)
          else if (ref != null) ref.current = element
        }}
        data-slot="dialog-content"
        data-variant={variant}
        initialFocus={initialFocusIn(popup)}
        className={cn(
          popupClassName,
          variant === "fullscreen" && "h-dvh max-h-dvh w-dvw max-w-dvw rounded-none",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            render={<IconButton className="absolute top-2 right-2" label="Close" tooltip="Close" icon={<Cancel aria-hidden="true" />} />}
          />
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

/** Title and optional description; leaves room for the close button. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col py-2.5 ps-4 pe-13", className)}
      {...props}
    />
  )
}

/** The scrolling middle. Padded at the sides, and at the top or bottom when nothing sits there. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        // Not first:/last: — the close button renders after the children.
        "min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4 [[data-slot=dialog-header]+&]:pt-0 [&:has(+[data-slot=dialog-footer])]:pb-0",
        className
      )}
      {...props}
    />
  )
}

/** The action row, right-aligned: Cancel first, the dialog's action last. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex shrink-0 items-center justify-end gap-2 p-4", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      tabIndex={-1}
      className={cn("text-xl/7 font-semibold outline-none", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-xs/5 text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  initialFocusIn,
  overlayClassName,
  popupClassName,
}
