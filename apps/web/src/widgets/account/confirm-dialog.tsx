import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
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
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} disablePointerDismissal>
      {/* Cancel is the way out, so no close button; 24px all round and the field flush with the title. */}
      <DialogContent className="w-[460px]" showCloseButton={false}>
        <DialogHeader className="gap-1.5 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg/7">{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription className="text-sm/6 text-foreground/80">{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="px-5">
          {children === undefined ? null : (
            // 4px in from the body's edge: room for the focus ring, which the scrolling body would clip.
            <div className="flex flex-col gap-3 p-1">{children}</div>
          )}
        </DialogBody>
        <DialogFooter className="pigui-confirm justify-between px-6 pt-5 pb-6">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {action}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
