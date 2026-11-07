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
 * back to this page (`?oauth_linked=`, `?oauth_error=`) and the screen App
 * shows has no panel of its own: the panel is where that's said. Decided on
 * the first render; `hasPanel` changing later doesn't open it.
 */
export function OAuthReturnDialog({ hasPanel }: { hasPanel: boolean }) {
  const [open, setOpen] = useState(() => {
    const { linked, error } = oauthReturn();
    return !hasPanel && (linked !== undefined || error !== undefined);
  });
  return open ? <AccountDialog onClose={() => setOpen(false)} /> : null;
}
