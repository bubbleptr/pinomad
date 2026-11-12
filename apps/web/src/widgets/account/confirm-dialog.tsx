import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import type { ReactNode } from "react";

/**
 * One account action, confirmed: what it does in the header, the fields it
 * needs in the body, and the action beside Cancel in the footer. Every
 * account change opens one of these instead of growing the page.
 */
export function ConfirmDialog({
  title,
  description,
  children,
  action,
  onClose,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  /** The final step's button; Cancel sits before it. */
  action: ReactNode;
  onClose: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description === undefined ? null : <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children === undefined ? null : <div className="flex flex-col gap-3">{children}</div>}
        <AlertDialogFooter>
          <AlertDialogCancel />
          {action}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
