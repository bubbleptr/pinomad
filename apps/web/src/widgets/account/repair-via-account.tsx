import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import { useEffect, useState } from "react";
import type { AccountError } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { useHosts } from "../../entities/host/host-store.ts";
import { accountErrorMessage } from "./account-panel.tsx";

/**
 * On the "this device isn't paired" screen: when the refused host belongs to
 * the signed-in account, offer an explicit re-pair. The host is still the
 * judge — a revoked key gets a fresh one here, and the host may refuse it too.
 */
export function RepairViaAccount({ hostKey }: { hostKey: string }) {
  const account = useAccountModel();
  const { state } = account;
  const { focusHost } = useHosts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  useEffect(() => account.hostRejected(hostKey), [account, hostKey]);
  if (state.status !== "signed-in") return null;
  const match = state.hosts.find((each) => each.stored?.hostKey === hostKey);
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
    <VStack gap={2} hAlign="center">
      <Button
        label="Pair again with your account"
        variant="primary"
        isLoading={busy}
        isDisabled={match.host.pairing !== "available"}
        onClick={pair}
      />
      {error === undefined ? null : <Banner status="error" title="Couldn't pair" description={accountErrorMessage(error)} />}
    </VStack>
  );
}
