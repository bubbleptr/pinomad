import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
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
    <VStack gap={6} className="w-full max-w-md">
      <VStack gap={2}>
        <Heading level={2}>{`${label ?? "This host"} no longer accepts this device`}</Heading>
        <Text type="supporting">
          This device was unpaired from it, or its pairing was never accepted. Pair again to keep using it.
        </Text>
      </VStack>
      <RepairViaAccount hostKey={hostKey} />
      <VStack gap={2}>
        <Text weight="semibold">{viaAccount ? "Or pair with a link" : "Pair with a link"}</Text>
        <Text type="supporting">
          {`Run pinomad pair on ${label ?? "the host"}, or open Settings → Devices → Pair a device on a device still paired with it.`}
        </Text>
        <PairingLinkForm connectVariant={viaAccount ? "secondary" : "primary"} />
      </VStack>
      <HStack gap={2} hAlign="between" vAlign="center">
        {account.state.status === "signed-out" ? (
          <Button label="Sign in to pair through your account" variant="ghost" size="sm" onClick={() => setAccountOpen(true)} />
        ) : (
          <span />
        )}
        <Button
          label={label === undefined ? "Unpair" : `Unpair ${label}`}
          variant="secondary"
          size="sm"
          onClick={() => void forget(hostKey)}
        />
      </HStack>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </VStack>
  );
}
