import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { useState } from "react";
import type { AccountError } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { accountErrorMessage } from "./account-error.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";

export interface RemoveHostProps {
  readonly account: AccountModel;
  readonly hostId: string;
  readonly name: string;
  readonly serverOrigin: string;
  /** `removed` is true once the host is off the account, here or already elsewhere. */
  readonly onClose: (removed: boolean) => void;
}

/**
 * Takes a host off the account (#512). Confirmed again, as for removing a
 * device (ADR-0037 §3, ADR-0044 §6): a session left on a lost phone mustn't be able to
 * take the owner's hosts away.
 */
export function RemoveHost({ account, hostId, name, serverOrigin, onClose }: RemoveHostProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const submit = (): void => {
    if (!identity.ready || busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await account.removeHost({ hostId, confirmation: confirmation.value }) : confirmation;
      setBusy(false);
      // Also ok when it was already gone (removed from another device).
      if (result.ok) onClose(true);
      else {
        if (result.error.code === "invalid_reauth") identity.reset();
        setError(result.error);
      }
    })();
  };
  const identity = useConfirmIdentity(account, submit);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs/5 text-muted-foreground">
        {name} leaves your account and stops connecting through {new URL(serverOrigin).host}. Only running pinomad up on
        that machine brings it back. This device forgets it too, unless you paired it with a QR code.
      </span>
      {identity.field}
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Couldn't remove the host</AlertTitle>
          <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button variant="destructive" loading={busy} disabled={!identity.ready} onClick={submit}>Remove host</Button>
        <Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>
      </div>
    </div>
  );
}

/** The same form on its own, for the new-host notice. */
export function RemoveHostDialog(props: RemoveHostProps) {
  return (
    <Dialog aria-label={`Remove ${props.name}`} isOpen purpose="form" onOpenChange={(open) => (open ? undefined : props.onClose(false))} width={440}>
      <Layout
        header={<DialogHeader title={`Remove ${props.name}`} onOpenChange={() => props.onClose(false)} />}
        content={
          <LayoutContent>
            <div style={{ padding: "var(--spacing-2)" }}>
              <RemoveHost {...props} />
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
