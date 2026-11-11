import { Button } from "../../shared/ui/button.tsx";
import { useState } from "react";
import { hostLabels } from "@pinomad/client/stored-host.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { useHosts } from "../../entities/host/host-store.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";
import { accountHostFor, RepairViaAccount } from "../account/repair-via-account.tsx";

/**
 * The host refused this device (4401): it was unpaired there, or its pairing
 * never took. Pairing again comes first — through the account when it can
 * vouch for this host, else a fresh link — and unpairing the dead entry here
 * second. A bare 4401 never removes it on its own (ADR-0032 §6).
 */
export function DeviceRejected({ hostKey }: { hostKey: string }) {
  const { hosts, forget } = useHosts();
  const account = useAccountModel();
  const [accountOpen, setAccountOpen] = useState(false);
  const label = hostLabels(hosts).get(hostKey);
  const viaAccount = accountHostFor(account.state, hostKey) !== undefined;
  return (
    <div className="flex flex-col gap-6 w-full max-w-md">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl/7 font-semibold">{`${label ?? "This host"} no longer accepts this device`}</h2>
        <span className="text-xs/5 text-muted-foreground">
          This device was unpaired from it, or its pairing was never accepted. Pair again to keep using it.
        </span>
      </div>
      <RepairViaAccount hostKey={hostKey} />
      <div className="flex flex-col gap-2">
        <span className="text-sm/5 font-semibold">{viaAccount ? "Or pair with a link" : "Pair with a link"}</span>
        <span className="text-xs/5 text-muted-foreground">
          {`Run pinomad pair on ${label ?? "the host"}, or open Settings → Devices → Pair a device on a device still paired with it.`}
        </span>
        <PairingLinkForm connectVariant={viaAccount ? "secondary" : "primary"} />
      </div>
      <div className="flex items-center justify-between gap-2">
        {account.state.status === "signed-out" ? (
          <Button variant="ghost" size="sm" onClick={() => setAccountOpen(true)}>Sign in to pair through your account</Button>
        ) : (
          <span />
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void forget(hostKey)}
        >
          {label === undefined ? "Unpair" : `Unpair ${label}`}
        </Button>
      </div>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </div>
  );
}
