import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { HStack, Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { hostLabels } from "@pinomad/client/stored-host.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { forgetHost, switchHost, useHosts } from "../../entities/host/host-store.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { Computer, Plus, Trash2, User } from "../../shared/ui/icons.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";

/**
 * The host switcher. One connection at a time: picking another host stores
 * the choice and reloads — the same pattern a pasted link uses to re-resolve
 * the address.
 */
export function HostSwitcher({
  onPairAnother,
  onOpenAccount,
  onForgetHost,
}: {
  onPairAnother: () => void;
  onOpenAccount: () => void;
  onForgetHost: () => void;
}) {
  const { hosts, activeHostKey } = useHosts();
  const account = useAccountModel();
  const labels = hostLabels(hosts);
  const current = hosts.find((host) => host.hostKey === activeHostKey) ?? hosts[0];
  return (
    <DropdownMenu
      placement="above"
      button={{
        label: current === undefined ? "Hosts" : (labels.get(current.hostKey) ?? "Hosts"),
        icon: <Computer aria-hidden="true" />,
        variant: "ghost",
        size: "sm",
        width: "100%",
      }}
    >
      <DropdownMenuRadioGroup
        label="Hosts"
        value={current?.hostKey}
        onChange={switchHost}
      >
        {hosts.map((host) => (
          <DropdownMenuRadioItem key={host.hostKey} value={host.hostKey} label={labels.get(host.hostKey)} />
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuItem label="Pair another host…" icon={<Plus aria-hidden="true" />} onClick={onPairAnother} />
      {current === undefined ? null : (
        // DropdownMenuItem has no danger variant; the label carries the
        // destructive color. "…" — a confirmation dialog follows.
        <DropdownMenuItem
          label={<span className="text-danger">Forget this host…</span>}
          icon={<Trash2 aria-hidden="true" />}
          onClick={onForgetHost}
        />
      )}
      {/* Only where this client can reach an account API at all (ADR-0022). */}
      {account.state.status === "unavailable" ? null : (
        <DropdownMenuItem label="Account…" icon={<User aria-hidden="true" />} onClick={onOpenAccount} />
      )}
    </DropdownMenu>
  );
}

/**
 * The paste-a-link dialog behind "Pair another host…". Hoisted next to
 * DevicesDialog for the same reason: inside MobileNav it would render in the
 * drawer that the click just closed.
 */
export function PairHostDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Pair another host"
            subtitle="Paste a pairing link from pinomad pair or Devices → Pair a device."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <PairingLinkForm />
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

/**
 * The confirm step behind "Forget this host…" — hoisted next to
 * PairHostDialog for the same MobileNav reason. Forgetting drops only this
 * device's stored key; the host keeps its device registration until it is
 * revoked there.
 */
export function ForgetHostDialog({ onClose }: { onClose: () => void }) {
  const { store, hosts, activeHostKey } = useHosts();
  const current = hosts.find((host) => host.hostKey === activeHostKey) ?? hosts[0];
  // The menu item exists only with a host shown; if the list emptied before
  // this rendered there is nothing left to forget.
  if (current === undefined) return null;
  const label = hostLabels(hosts).get(current.hostKey) ?? current.url;
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title={`Forget ${label}?`}
            subtitle="This computer needs a new pairing link to connect to it again."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <Text type="supporting">
              The host still lists this device — revoke it under Devices on that host to remove it completely.
            </Text>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Forget this host" variant="destructive" onClick={() => forgetHost(store, current.hostKey)} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/**
 * Connection-failure screens have no sidebar; they still owe the user a way
 * off a dead host — the same switcher, inline. Centered's column is
 * window-wide, so the full-width button is boxed and spaced like the
 * screens' own blocks.
 */
export function HostSwitcherFallback() {
  const [pairing, setPairing] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  return (
    <div className="mt-4 w-80">
      <HostSwitcher
        onPairAnother={() => setPairing(true)}
        onOpenAccount={() => setAccountOpen(true)}
        onForgetHost={() => setForgetting(true)}
      />
      {pairing ? <PairHostDialog onClose={() => setPairing(false)} /> : null}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
      {forgetting ? <ForgetHostDialog onClose={() => setForgetting(false)} /> : null}
    </div>
  );
}
