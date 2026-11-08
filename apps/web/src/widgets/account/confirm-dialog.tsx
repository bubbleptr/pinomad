import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
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
              <VStack gap={3} style={{ padding: "var(--spacing-2)" }}>
                {children}
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              {action}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
