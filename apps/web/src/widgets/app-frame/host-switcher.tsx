import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { useState } from "react";
import { hostLabels } from "@pinomad/client/stored-host.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { switchHost, useHosts } from "../../entities/host/host-store.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { Computer, Plus, User } from "../../shared/ui/icons.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";

/**
 * The host switcher. One connection at a time: picking another host stores
 * the choice and reloads — the same pattern a pasted link uses to re-resolve
 * the address.
 */
export function HostSwitcher({ onPairAnother, onOpenAccount }: { onPairAnother: () => void; onOpenAccount: () => void }) {
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
 * Connection-failure screens have no sidebar; they still owe the user a way
 * off a dead host — the same switcher, inline. Centered's column is
 * window-wide, so the full-width button is boxed and spaced like the
 * screens' own blocks.
 */
export function HostSwitcherFallback() {
  const [pairing, setPairing] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <div className="mt-4 w-80">
      <HostSwitcher onPairAnother={() => setPairing(true)} onOpenAccount={() => setAccountOpen(true)} />
      {pairing ? <PairHostDialog onClose={() => setPairing(false)} /> : null}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </div>
  );
}
