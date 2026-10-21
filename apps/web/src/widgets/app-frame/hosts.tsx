import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useState } from "react";
import type { ConnectionState } from "@pinomad/protocol/view.ts";
import { hostLabels, type StoredHost } from "@pinomad/client/stored-host.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { forgetHost, switchHost, useHosts } from "../../entities/host/host-store.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { Check, Computer } from "../../shared/ui/icons.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";

/**
 * The paired hosts with their labels, which one is selected, and which one
 * this page's connection actually reaches — a token client is connected to
 * none of them. One connection at a time, so at most one entry is connected.
 */
function usePairedHosts(connection: ConnectionState | undefined, connectedHostKey: string | undefined) {
  const { store, hosts, activeHostKey } = useHosts();
  const labels = hostLabels(hosts);
  const currentKey = (hosts.find((host) => host.hostKey === activeHostKey) ?? hosts[0])?.hostKey;
  return {
    store,
    hosts,
    label: (host: StoredHost): string => labels.get(host.hostKey) ?? host.url,
    isCurrent: (host: StoredHost): boolean => host.hostKey === currentKey,
    isConnected: (host: StoredHost): boolean => host.hostKey === connectedHostKey && connection === "connected",
  };
}

/**
 * Breathing green while connected, grey otherwise. Decorative: callers put
 * the status into the accessible name themselves, so the dot's own label
 * doesn't leak into it.
 */
function HostStatusDot({ connected }: { connected: boolean }) {
  return (
    <span aria-hidden="true" className="inline-flex">
      {connected ? (
        <StatusDot variant="success" label="Connected" isPulsing />
      ) : (
        <StatusDot variant="neutral" label="Not connected" />
      )}
    </span>
  );
}

const statusText = (connected: boolean): string => (connected ? "connected" : "not connected");

/**
 * The sidebar's hosts button: a list of each paired host's name and
 * connection status. Picking another host switches to it — the stored choice
 * plus a reload, like a pasted link.
 */
export function HostsMenu({
  connection,
  connectedHostKey,
}: {
  connection: ConnectionState | undefined;
  connectedHostKey: string | undefined;
}) {
  const paired = usePairedHosts(connection, connectedHostKey);
  return (
    <DropdownMenu
      hasChevron={false}
      placement="above"
      alignment="end"
      menuWidth={240}
      button={{
        icon: <Computer aria-hidden="true" />,
        isIconOnly: true,
        label: "Hosts",
        tooltip: "Hosts",
        size: "sm",
        variant: "ghost",
      }}
    >
      {paired.hosts.map((host) => {
        const connected = paired.isConnected(host);
        return (
          <DropdownMenuItem
            key={host.hostKey}
            icon={<HostStatusDot connected={connected} />}
            label={
              <>
                {paired.label(host)}
                <VisuallyHidden>{`(${statusText(connected)})`}</VisuallyHidden>
              </>
            }
            endContent={paired.isCurrent(host) ? <Check aria-hidden="true" className="size-4" /> : undefined}
            onClick={paired.isCurrent(host) ? undefined : () => switchHost(host.hostKey)}
          />
        );
      })}
    </DropdownMenu>
  );
}

/**
 * Settings → Hosts: the hosts this device has paired with, switching between
 * them, forgetting one, and pairing another. Belongs to this device, not to
 * the connected host, so it works while disconnected too.
 */
export function HostsSection({
  connection,
  connectedHostKey,
}: {
  connection: ConnectionState | undefined;
  connectedHostKey: string | undefined;
}) {
  const paired = usePairedHosts(connection, connectedHostKey);
  const [forgetting, setForgetting] = useState<StoredHost>();
  return (
    <VStack gap={5}>
      {paired.hosts.length === 0 ? (
        <Text type="supporting">No paired hosts.</Text>
      ) : (
        <List density="compact">
          {paired.hosts.map((host) => {
            const label = paired.label(host);
            const connected = paired.isConnected(host);
            return (
              <ListItem
                key={host.hostKey}
                startContent={<HostStatusDot connected={connected} />}
                label={label}
                description={statusText(connected).replace(/^./, (first) => first.toUpperCase())}
                endContent={
                  <HStack gap={2} vAlign="center">
                    {paired.isCurrent(host) ? (
                      <Token label="Current" size="sm" />
                    ) : (
                      <Button
                        label="Switch"
                        aria-label={`Switch to ${label}`}
                        variant="ghost"
                        size="sm"
                        onClick={() => switchHost(host.hostKey)}
                      />
                    )}
                    <Button
                      label="Forget…"
                      aria-label={`Forget ${label}…`}
                      variant="ghost"
                      size="sm"
                      onClick={() => setForgetting(host)}
                    />
                  </HStack>
                }
              />
            );
          })}
        </List>
      )}
      {forgetting === undefined ? null : (
        // Forgetting drops only this device's stored key; the host keeps the
        // device registration until it is revoked there.
        <VStack gap={2} role="group" aria-label={`Forget ${paired.label(forgetting)}?`}>
          <Text weight="semibold">{`Forget ${paired.label(forgetting)}?`}</Text>
          <Text type="supporting">
            This device needs a new pairing link to connect to it again. The host still lists this device — revoke
            it under Settings → Devices on that host to remove it completely.
          </Text>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" size="sm" onClick={() => setForgetting(undefined)} />
            <Button
              label="Forget this host"
              variant="destructive"
              size="sm"
              onClick={() => forgetHost(paired.store, forgetting.hostKey)}
            />
          </HStack>
        </VStack>
      )}
      <VStack gap={2}>
        <Heading level={3}>Pair a host</Heading>
        <Text type="supporting">Paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</Text>
        <PairingLinkForm />
      </VStack>
    </VStack>
  );
}

/**
 * Connection-failure screens have no sidebar; they still owe the user a way
 * off a dead host — the Hosts section inline, plus Account where this client
 * can reach one (ADR-0022).
 */
export function HostsFallback() {
  const account = useAccountModel();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <VStack gap={3} className="mt-4 w-full max-w-md">
      <HostsSection connection={undefined} connectedHostKey={undefined} />
      {account.state.status === "unavailable" ? null : (
        <div>
          <Button label="Account…" variant="ghost" size="sm" onClick={() => setAccountOpen(true)} />
        </div>
      )}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </VStack>
  );
}
