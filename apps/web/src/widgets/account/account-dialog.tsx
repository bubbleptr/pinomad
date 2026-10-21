import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { AccountPanel } from "./account-panel.tsx";

/** The account panel in a dialog, opened from the sidebar's user bar. */
export function AccountDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} width={480}>
      <Layout
        header={<DialogHeader title="Account" onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <div style={{ padding: "var(--spacing-2)" }}>
              <AccountPanel />
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
