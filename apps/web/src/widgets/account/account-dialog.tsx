import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { useState } from "react";
import { oauthReturn } from "../../entities/account/oauth-return.ts";
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

/**
 * The account panel, opened on its own when a provider link or sign-in came
 * back to this page (`?oauth_linked=`, `?oauth_error=`): the panel is where
 * that's said. `stayClosed` when the screen App shows has a panel of its own,
 * or shouldn't be covered. Decided on the first render only.
 */
export function OAuthReturnDialog({ stayClosed }: { stayClosed: boolean }) {
  const [open, setOpen] = useState(() => {
    const { linked, error } = oauthReturn();
    return !stayClosed && (linked !== undefined || error !== undefined);
  });
  return open ? <AccountDialog onClose={() => setOpen(false)} /> : null;
}
