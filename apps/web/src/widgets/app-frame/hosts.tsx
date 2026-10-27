import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useEffect, useRef, useState } from "react";
import { hostLabels, type StoredHost } from "@pinomad/client/stored-host.ts";
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { ConnectionMode } from "@pinomad/protocol/connection-mode.ts";
import type { RemoteDurable, RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { RtcCandidateEnd } from "@pinomad/protocol/rtc.ts";
import type { ConnectionState } from "@pinomad/protocol/view.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { browserRtcAvailable } from "../../entities/host/browser-rtc.ts";
import { forgetHost, switchHost, useHosts } from "../../entities/host/host-store.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { Check, Computer } from "../../shared/ui/icons.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";
import {
  candidateEndLabel,
  failureLabel,
  PATH_LABEL,
  pathLabel,
} from "./hosts-diagnostics.ts";

/** The coordinator methods this panel pulls diagnostics from. */
export type HostsRtc = Pick<RemoteDurable, "rtcDiagnostics" | "setConnectionMode">;

const MODE_HELP: Record<ConnectionMode, string> = {
  auto: "Start on the relay, then switch to a direct peer-to-peer link once it is stable.",
  directOnly: "Never send conversation data through the PiNomad server. The relay is used only to set up the link.",
  relayOnly: "Always go through the relay; never try peer-to-peer.",
};

/** Minutes for the 10-minute cap, seconds for the short first cooldowns. */
function cooldownLabel(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`;
}

/**
 * The panel and the row both need the path, and the coordinator only exposes
 * a pull API. Poll while this section is visible (Settings open, or the
 * failure fallback), not from a global timer; unmounting stops it.
 */
function useRtcDiagnostics(remote: HostsRtc | undefined, active: boolean): RtcDiagnostics | undefined {
  const [diagnostics, setDiagnostics] = useState<RtcDiagnostics>();
  useEffect(() => {
    if (!active || remote === undefined) {
      setDiagnostics(undefined);
      return;
    }
    const read = (): void => setDiagnostics(remote.rtcDiagnostics());
    read();
    const timer = setInterval(read, 1_000);
    return () => clearInterval(timer);
  }, [active, remote]);
  return diagnostics;
}

function p2pStatus({
  diagnostics,
  mode,
  hostMinor,
  rtcAvailable,
  connectedSince,
}: {
  diagnostics: RtcDiagnostics | undefined;
  mode: ConnectionMode;
  hostMinor: number | undefined;
  rtcAvailable: boolean;
  connectedSince: number;
}): string {
  if (!rtcAvailable) return "Not available in this browser";
  if (hostMinor !== undefined && !hostSupportsFeature(hostMinor, "rtc")) return "Not available on this host";
  if (mode === "relayOnly") return "Off (Relay only)";
  if (diagnostics === undefined) return "Preparing…";
  if (diagnostics.path === "p2p" || diagnostics.phase === "active") return "Active";
  if (diagnostics.phase === "cooldown") {
    return `Cooling down · retry in ${cooldownLabel(diagnostics.cooldownRemainingMs)}`;
  }
  if (diagnostics.phase !== "idle") return "Preparing…";
  // A failure is shown in its own row; the coordinator is between attempts.
  if (diagnostics.lastFailure !== undefined) return "Idle";
  // The coordinator schedules its first upgrade 1s after ready when the host
  // advertised hello.rtc. An idle coordinator past that grace means this host
  // has no native RTC module, not that preparation is still running.
  if (Date.now() - connectedSince > 2_500) return "Not available on this host";
  return "Preparing…";
}

function AddressRow({ label, end }: { label: string; end: RtcCandidateEnd }) {
  return (
    <HStack gap={2} vAlign="start">
      <Text type="supporting" className="w-20 shrink-0">
        {label}
      </Text>
      <Text type="code" hasTabularNumbers style={{ wordBreak: "break-all", userSelect: "all" }}>
        {candidateEndLabel(end)}
      </Text>
    </HStack>
  );
}

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
  remote,
  hostMinor,
  rtcAvailable = browserRtcAvailable(),
  onRetry,
}: {
  connection: ConnectionState | undefined;
  connectedHostKey: string | undefined;
  /** The live coordinator, when this page has one; the failure fallback has none. */
  remote?: HostsRtc;
  /** The connected host's protocol minor, for the RTC capability gate. */
  hostMinor?: number;
  /** Test/story seam; production reads the real browser capability. */
  rtcAvailable?: boolean;
  /** Reconnect from a failure screen after a preference change. */
  onRetry?: () => void;
}) {
  const paired = usePairedHosts(connection, connectedHostKey);
  const { setConnection } = useHosts();
  const [forgetting, setForgetting] = useState<StoredHost>();
  const [connectionFor, setConnectionFor] = useState<StoredHost>();
  const [modeError, setModeError] = useState<string>();
  const connected = connection === "connected";
  const diagnostics = useRtcDiagnostics(remote, connected && connectedHostKey !== undefined);
  const connectedSince = useRef(Date.now());
  useEffect(() => {
    connectedSince.current = Date.now();
  }, [connected, connectedHostKey]);

  const toggleConnection = (host: StoredHost): void => {
    setModeError(undefined);
    setForgetting(undefined);
    setConnectionFor((previous) => (previous?.hostKey === host.hostKey ? undefined : host));
  };

  const changeMode = (host: StoredHost, mode: ConnectionMode): void => {
    setModeError(undefined);
    void setConnection(host.hostKey, { connectionMode: mode }).then(
      () => {
        // Reconnect only the host this coordinator actually serves. A token
        // connection has no stored host key, so changing a saved host must
        // not tear that connection down.
        const liveHost = connectedHostKey !== undefined && host.hostKey === connectedHostKey;
        if (liveHost) {
          // A closed coordinator cannot switch modes itself; remount it so
          // the new preference is read by a fresh connection.
          if (connection !== "closed" && remote !== undefined) remote.setConnectionMode(mode);
          else onRetry?.();
          return;
        }
        // The failure fallback has no coordinator and no connected key; the
        // saved selection is then the host the page failed to reach.
        if (connectedHostKey === undefined && remote === undefined && paired.isCurrent(host)) onRetry?.();
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("Could not store the host connection mode", error);
        setModeError(reason);
      },
    );
  };

  const description = (host: StoredHost): string => {
    if (!paired.isConnected(host)) return "Not connected";
    return diagnostics === undefined ? "Connected" : `Connected · ${PATH_LABEL[diagnostics.path]}`;
  };
  // The store update replaces the host object under the panel; read the
  // current entry so the selected segment follows the write, not a snapshot.
  const connectionHost =
    connectionFor === undefined
      ? undefined
      : (paired.hosts.find((host) => host.hostKey === connectionFor.hostKey) ?? connectionFor);

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
                description={description(host)}
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
                      label="Connection…"
                      aria-label={`Connection to ${label}`}
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleConnection(host)}
                    />
                    <Button
                      label="Forget…"
                      aria-label={`Forget ${label}…`}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setConnectionFor(undefined);
                        setForgetting(host);
                      }}
                    />
                  </HStack>
                }
              />
            );
          })}
        </List>
      )}
      {connectionHost === undefined ? null : (
        <VStack gap={3} role="group" aria-label={`Connection to ${paired.label(connectionHost)}`}>
          <Text weight="semibold">{`Connection to ${paired.label(connectionHost)}`}</Text>
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <SegmentedControl
                className="shrink-0"
                value={connectionHost.connectionMode ?? "auto"}
                onChange={(next) => changeMode(connectionHost, next as ConnectionMode)}
                label="Connection mode"
                size="sm"
              >
                <SegmentedControlItem value="auto" label="Auto" />
                <SegmentedControlItem value="directOnly" label="Direct only" />
                <SegmentedControlItem value="relayOnly" label="Relay only" />
              </SegmentedControl>
            </HStack>
            <Text type="supporting">{MODE_HELP[connectionHost.connectionMode ?? "auto"]}</Text>
          </VStack>
          {modeError === undefined ? null : (
            <Text type="supporting">{`Could not save the connection mode: ${modeError}`}</Text>
          )}
          {paired.isConnected(connectionHost) ? (
            <VStack gap={1}>
              <Text weight="semibold">Status</Text>
              <List density="compact">
                <ListItem
                  label="Path"
                  description={
                    <VStack gap={1}>
                      <Text type="inherit">{diagnostics === undefined ? "—" : pathLabel(diagnostics)}</Text>
                      {diagnostics?.path === "p2p" && diagnostics.selectedPair !== undefined ? (
                        <Collapsible
                          defaultIsOpen={false}
                          trigger={
                            <Text type="body" size="sm" color="secondary" className="block min-h-11 py-3">
                              Show addresses
                            </Text>
                          }
                        >
                          <VStack gap={1}>
                            <AddressRow label="This device" end={diagnostics.selectedPair.local} />
                            <AddressRow label="Host" end={diagnostics.selectedPair.remote} />
                          </VStack>
                        </Collapsible>
                      ) : null}
                    </VStack>
                  }
                />
                <ListItem
                  label="Peer-to-peer"
                  description={p2pStatus({
                    diagnostics,
                    mode: connectionHost.connectionMode ?? "auto",
                    hostMinor,
                    rtcAvailable,
                    connectedSince: connectedSince.current,
                  })}
                />
                {diagnostics?.lastFailure === undefined ? null : (
                  <ListItem
                    label="Last failure"
                    // A node wraps instead of truncating; the age ticks every second.
                    description={
                      <Text type="inherit" hasTabularNumbers>
                        {failureLabel(diagnostics.lastFailure)}
                      </Text>
                    }
                  />
                )}
              </List>
            </VStack>
          ) : null}
          <HStack hAlign="end">
            <Button label="Close" variant="secondary" size="sm" onClick={() => setConnectionFor(undefined)} />
          </HStack>
        </VStack>
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
export function HostsFallback({ onRetry }: { onRetry?: () => void }) {
  const account = useAccountModel();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <VStack gap={3} className="mt-4 w-full max-w-md">
      <HostsSection
        connection={undefined}
        connectedHostKey={undefined}
        hostMinor={undefined}
        onRetry={onRetry}
      />
      {account.state.status === "unavailable" ? null : (
        <div>
          <Button label="Account…" variant="ghost" size="sm" onClick={() => setAccountOpen(true)} />
        </div>
      )}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </VStack>
  );
}
