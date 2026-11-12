import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { cn } from "cn"

import { Button } from "@/shared/ui/button"
import { overlayClassName, popupClassName } from "@/shared/ui/dialog"

/**
 * A yes/no question before an irreversible step. Only Escape and Cancel
 * dismiss it (no click outside), and focus starts on Cancel.
 */
function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogContent({ className, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop data-slot="alert-dialog-overlay" className={overlayClassName} />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(popupClassName, className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-1 px-4 pt-4", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("pigui-confirm flex items-center justify-between gap-2 p-4", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-xl/7 font-semibold", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm/6 text-foreground/80", className)}
      {...props}
    />
  )
}

/** The final step; pass `variant="destructive"` for an irreversible one. It doesn't close the dialog by itself. */
function AlertDialogAction({ ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" {...props} />
}

function AlertDialogCancel({ children = "Cancel", ...props }: AlertDialogPrimitive.Close.Props) {
  return (
    <AlertDialogPrimitive.Close
      render={<Button variant="secondary" />}
      {...props}
    >
      {children}
    </AlertDialogPrimitive.Close>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
}
