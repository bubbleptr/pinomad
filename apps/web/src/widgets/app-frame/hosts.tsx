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
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { browserRtcAvailable } from "../../entities/host/browser-rtc.ts";
import { connectionStatus, hostStatusText, useHostRuntimeInfos, type HostRuntimeInfo } from "../../entities/host/host-runtimes.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { Computer } from "../../shared/ui/icons.tsx";
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
    <HStack gap={2} style={{ alignItems: "baseline" }}>
      <Text type="supporting" className="w-20 shrink-0">
        {label}
      </Text>
      <Text
        type="code"
        size="sm"
        color="secondary"
        hasTabularNumbers
        style={{ wordBreak: "break-all", userSelect: "all" }}
      >
        {candidateEndLabel(end)}
      </Text>
    </HStack>
  );
}

/**
 * The paired hosts with their labels, the focused one, and each host's own
 * runtime status (ADR-0035 §4) — a token client is connected to none of them.
 */
function usePairedHosts() {
  const { hosts, focus, focusHost } = useHosts();
  const infos = useHostRuntimeInfos();
  const labels = hostLabels(hosts);
  const info = (host: StoredHost): HostRuntimeInfo | undefined => infos.get(host.hostKey);
  return {
    hosts,
    focusHost,
    label: (host: StoredHost): string => labels.get(host.hostKey) ?? host.url,
    isCurrent: (host: StoredHost): boolean => focus?.hostKey === host.hostKey,
    isConnected: (host: StoredHost): boolean => connectionStatus(info(host)) === "connected",
    info,
    infoOf: (hostKey: string | undefined): HostRuntimeInfo | undefined =>
      hostKey === undefined ? undefined : infos.get(hostKey),
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

/**
 * The sidebar's hosts button: each paired host's name and connection status —
 * the only place the sidebar shows it (#213). Picking a host brings its group
 * into view; focus stays where it is (#427).
 */
export function HostsMenu({ onLocate }: { onLocate?: (hostKey: string) => void }) {
  const paired = usePairedHosts();
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
      {paired.hosts.map((host) => (
        <DropdownMenuItem
          key={host.hostKey}
          icon={<HostStatusDot connected={paired.isConnected(host)} />}
          label={
            <>
              {paired.label(host)}
              <VisuallyHidden>{`(${hostStatusText(paired.info(host)).toLowerCase()})`}</VisuallyHidden>
            </>
          }
          {...(onLocate === undefined ? {} : { onClick: () => onLocate(host.hostKey) })}
        />
      ))}
    </DropdownMenu>
  );
}

/**
 * Settings → Hosts: every paired host with its own runtime status, switching
 * focus, forgetting one, and pairing another. Belongs to this device, not to
 * the focused host, so it works while every connection is down too.
 */
export function HostsSection({
  rtcAvailable = browserRtcAvailable(),
}: {
  /** Test/story seam; production reads the real browser capability. */
  rtcAvailable?: boolean;
}) {
  const paired = usePairedHosts();
  const { setConnection, forget, focus } = useHosts();
  const [forgetting, setForgetting] = useState<StoredHost>();
  const [connectionFor, setConnectionFor] = useState<StoredHost>();
  const [modeError, setModeError] = useState<string>();
  const connectionInfo =
    connectionFor === undefined ? undefined : paired.info(connectionFor);
  const connected = connectionStatus(connectionInfo) === "connected";
  // The row for the panel's host — or the focused one when no panel is open —
  // carries the live path, so the list still shows where it is routing.
  const diagnosticsHostKey = connectionFor?.hostKey ?? focus?.hostKey;
  const diagnosticsInfo = paired.infoOf(diagnosticsHostKey);
  const diagnosticsRemote = diagnosticsInfo?.phase === "ready" ? diagnosticsInfo.remote : undefined;
  const diagnostics = useRtcDiagnostics(
    diagnosticsRemote,
    connectionStatus(diagnosticsInfo) === "connected",
  );
  const connectedSince = useRef(Date.now());
  useEffect(() => {
    connectedSince.current = Date.now();
  }, [diagnosticsRemote, diagnosticsHostKey]);
  const connectionHost =
    connectionFor === undefined
      ? undefined
      : (paired.hosts.find((host) => host.hostKey === connectionFor.hostKey) ?? connectionFor);
  const connectionHostMinor =
    connectionInfo?.phase === "ready" ? connectionInfo.view.host?.protocol.minor : undefined;

  const toggleConnection = (host: StoredHost): void => {
    setModeError(undefined);
    setForgetting(undefined);
    setConnectionFor((previous) => (previous?.hostKey === host.hostKey ? undefined : host));
  };

  const changeMode = (host: StoredHost, mode: ConnectionMode): void => {
    setModeError(undefined);
    void setConnection(host.hostKey, { connectionMode: mode }).then(
      () => {
        const live = paired.info(host);
        if (live === undefined) return;
        if (live.phase !== "ready") {
          // A connecting/failed runtime cannot switch modes itself; remount
          // it so the new preference is read by the next attempt.
          live.retry();
          return;
        }
        // A terminal coordinator cannot switch modes itself; remount it so
        // the new preference is read by a fresh connection.
        if (live.view.connection === "closed" || live.view.connection === "outdated") live.retry();
        else live.remote.setConnectionMode(mode);
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("Could not store the host connection mode", error);
        setModeError(reason);
      },
    );
  };

  const description = (host: StoredHost): string => {
    const info = paired.info(host);
    if (connectionStatus(info) !== "connected") return hostStatusText(info);
    return diagnosticsHostKey === host.hostKey && diagnostics !== undefined
      ? `Connected · ${PATH_LABEL[diagnostics.path]}`
      : "Connected";
  };

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
                        onClick={() => paired.focusHost(host.hostKey)}
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
                    hostMinor: connectionHostMinor,
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
              onClick={() => {
                const host = forgetting;
                setForgetting(undefined);
                setConnectionFor(undefined);
                void forget(host.hostKey).catch((error: unknown) =>
                  console.error("Could not forget the host", error),
                );
              }}
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
 * The connection-failure screens repeat the device's hosts inline. The frame's
 * sidebar now stays up too, but a dead focused host still needs its own way
 * off — the Hosts section plus Account where this client can reach one
 * (ADR-0022). PR-B decides whether this inline copy stays.
 */
export function HostsFallback() {
  const account = useAccountModel();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <VStack gap={3} className="mt-4 w-full max-w-md">
      <HostsSection />
      {account.state.status === "unavailable" ? null : (
        <div>
          <Button label="Account…" variant="ghost" size="sm" onClick={() => setAccountOpen(true)} />
        </div>
      )}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </VStack>
  );
}
