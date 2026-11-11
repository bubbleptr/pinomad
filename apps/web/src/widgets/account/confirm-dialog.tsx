import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
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
    <Dialog aria-label={title} isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={460}>
      <Layout
        header={
          <DialogHeader
            title={title}
            {...(description === undefined ? {} : { subtitle: description })}
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            {children === undefined ? null : (
              <div className="flex flex-col gap-3" style={{ padding: "var(--spacing-2)" }}>
                {children}
              </div>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              {action}
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
