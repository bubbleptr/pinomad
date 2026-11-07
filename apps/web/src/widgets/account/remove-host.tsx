import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import type { AccountError } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { accountErrorMessage } from "./account-error.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";

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
    <VStack gap={2}>
      <Text type="supporting">
        {name} leaves your account and stops connecting through {new URL(serverOrigin).host}. Only running pinomad up on
        that machine brings it back. This device forgets it too, unless you paired it with a QR code.
      </Text>
      {identity.field}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't remove the host" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2}>
        <Button label="Remove host" variant="destructive" isLoading={busy} isDisabled={!identity.ready} onClick={submit} />
        <Button label="Cancel" variant="secondary" onClick={() => onClose(false)} />
      </HStack>
    </VStack>
  );
}

/** The same form on its own, for the new-host notice. */
export function RemoveHostDialog(props: RemoveHostProps) {
  return (
    <Dialog isOpen purpose="form" onOpenChange={(open) => (open ? undefined : props.onClose(false))} width={440}>
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
