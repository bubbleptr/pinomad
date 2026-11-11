import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { useState } from "react";
import { oauthReturn } from "../../entities/account/oauth-return.ts";
import { AccountPanel, type AccountPage } from "./account-panel.tsx";

/**
 * The account panel on its own: signing in from the sidebar, and the account
 * where no Settings is at hand (the one-shot screens, a provider link's return).
 */
export function AccountDialog({ initialPage, onClose }: { initialPage?: AccountPage; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="w-[480px]">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div style={{ padding: "var(--spacing-2)" }}>
            <AccountPanel {...(initialPage === undefined ? {} : { initialPage })} />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The account panel, opened on its own when a provider link or sign-in came
 * back to this page (`?oauth_linked=`, `?oauth_error=`): the account page
 * says how a link went; signed out, the sign-in form says why it was refused. `stayClosed` when the screen App shows has a panel of its own,
 * or shouldn't be covered. Decided on the first render only.
 */
export function OAuthReturnDialog({ stayClosed }: { stayClosed: boolean }) {
  const [open, setOpen] = useState(() => {
    const { linked, error } = oauthReturn();
    return !stayClosed && (linked !== undefined || error !== undefined);
  });
  return open ? <AccountDialog onClose={() => setOpen(false)} /> : null;
}
