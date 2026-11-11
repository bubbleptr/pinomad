import { Button } from "../../shared/ui/button.tsx";
import { useEffect, useState } from "react";
import type { AccountError } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountState } from "../../entities/account/account-model.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { accountErrorMessage } from "./account-error.ts";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";

/**
 * On the "this device isn't paired" screen: when the refused host belongs to
 * the signed-in account, offer an explicit re-pair. The host is still the
 * judge — a revoked key gets a fresh one here, and the host may refuse it too.
 */
export function RepairViaAccount({ hostKey }: { hostKey: string }) {
  const account = useAccountModel();
  const { focusHost } = useHosts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  useEffect(() => account.hostRejected(hostKey), [account, hostKey]);
  const match = accountHostFor(account.state, hostKey);
  if (match === undefined) return null;
  const pair = (): void => {
    setBusy(true);
    setError(undefined);
    void account.pairHost(match.host.hostId).then((result) => {
      setBusy(false);
      if (result.ok) focusHost(result.value.hostKey);
      else setError(result.error);
    });
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="primary"
        loading={busy}
        disabled={match.host.pairing !== "available"}
        onClick={pair}
      >
        Pair again with your account
      </Button>
      {error === undefined ? null : <Alert variant="destructive"><AlertTitle>Couldn't pair</AlertTitle><AlertDescription>{accountErrorMessage(error)}</AlertDescription></Alert>}
    </div>
  );
}

/** The signed-in account's entry for `hostKey`, when the account can re-pair it. */
export function accountHostFor(state: AccountState, hostKey: string) {
  return state.status === "signed-in" ? state.hosts.find((each) => each.stored?.hostKey === hostKey) : undefined;
}
