import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useToast } from "@astryxdesign/core/Toast";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useCallback, useEffect, useRef, useState } from "react";
import { hostLabels, type StoredHost } from "@pinomad/client/stored-host.ts";
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { ConnectionMode } from "@pinomad/protocol/connection-mode.ts";
import type { ConnectionPath, RemoteDurable, RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { RtcCandidateEnd } from "@pinomad/protocol/rtc.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { browserRtcAvailable } from "../../entities/host/browser-rtc.ts";
import {
  connectionStatus,
  hostStatusText,
  terminalReason,
  useHostRuntimeInfos,
  type HostRuntimeInfo,
} from "../../entities/host/host-runtimes.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { unansweredUnpair, unpairHost } from "../../entities/host/unpair.ts";
import { ArrowLeft, ChevronRight, Computer } from "../../shared/ui/icons.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";
import {
  ACCOUNT_HOST_ISSUE,
  AccountHostList,
  accountHostIssue,
  AccountPairingBanners,
  unpairedAccountHosts,
  useAccountPairing,
  type AccountHostIssue,
  type AccountPairing,
} from "../account/account-hosts.tsx";
import { AddHostDialog } from "../account/add-host.tsx";
import { RemoveHostDialog } from "../account/remove-host.tsx";
import { accountHostFor } from "../account/repair-via-account.tsx";
import { GROUP_ROWS, SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { hostRoutes, type HostRoute } from "./host-routes.ts";
import { useSettingsSubpage } from "./settings-subpage.ts";
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

const MODE_NAME: Record<ConnectionMode, string> = {
  auto: "Auto",
  directOnly: "Direct only",
  relayOnly: "Relay only",
};

function routeNote(route: HostRoute, mode: ConnectionMode): string | undefined {
  if (route.state === "blocked") return "Blocked on HTTPS";
  if (route.state === "off") return `Off in ${MODE_NAME[mode]}`;
  return undefined;
}

/** One machine's routes: each network or server this device can reach it over (#502). */
function HostRouteList({ host, routes }: { host: StoredHost; routes: readonly HostRoute[] }) {
  if (routes.length === 0) {
    return (
      <Text type="supporting">
        No published address
      </Text>
    );
  }
  return (
    <ul aria-label="Routes" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {routes.map((route) => {
        const note = routeNote(route, host.connectionMode ?? "auto");
        return (
          <li key={route.url} className={route.state === "available" ? "flex gap-2" : "flex gap-2 opacity-60"}>
            <Text type="supporting" className="w-24 shrink-0">
              {route.label}
            </Text>
            <Text type="code" size="sm" color="secondary" className="min-w-0" style={{ wordBreak: "break-all" }}>
              {route.address}
            </Text>
            {note === undefined ? null : (
              <Text type="supporting" className="shrink-0">
                {note}
              </Text>
            )}
          </li>
        );
      })}
    </ul>
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
      // As wide as the longest "name status" line; no fixed width to pad out.
      menuWidth="max-content"
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
              {/* Seen after the name; the hidden copy keeps the accessible
                  name "<host> (<status>)" without reading it twice. */}
              <span aria-hidden="true" className="ms-2 text-muted">
                {hostStatusText(paired.info(host))}
              </span>
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
 * Settings → Hosts: every machine this device can use. The ones paired here
 * come first, each with its own runtime status; signed in, the account's
 * others follow with Pair. A row offers at most one action — the host's own
 * page holds its connection, its routes (#502) and unpairing. Focus moves
 * from the sidebar's machine groups, except on the sidebar-less one-shot
 * screens (`canSwitch`). Belongs to this device, not to the focused host, so
 * it works while every connection is down too.
 */
export function HostsSection({
  rtcAvailable = browserRtcAvailable(),
  canSwitch = false,
}: {
  /** Test/story seam; production reads the real browser capability. */
  rtcAvailable?: boolean;
  /**
   * Offer Switch on every host: a one-shot pairing or token screen has no
   * sidebar to leave it by. Inside the frame focus moves from the sidebar.
   */
  canSwitch?: boolean;
}) {
  const paired = usePairedHosts();
  const { focus } = useHosts();
  const account = useAccountModel();
  const pairing = useAccountPairing();
  const [detailKey, setDetailKey] = useState<string>();
  const [adding, setAdding] = useState(false);
  const signedIn = account.state.status === "signed-in";
  // The account's list is refreshed on sign-in and on return to the
  // foreground; a host that joined since shows up when this page opens.
  useEffect(() => {
    if (signedIn) void account.refreshHosts();
  }, [account, signedIn]);
  const detail = paired.hosts.find((host) => host.hostKey === detailKey);
  const closeDetail = useCallback(() => setDetailKey(undefined), []);
  const settingsOwnsBack = useSettingsSubpage(detail === undefined ? undefined : { title: paired.label(detail), back: closeDetail });
  // Only one host has live diagnostics: the open page's, else the focused one.
  const diagnosticsHostKey = detail?.hostKey ?? focus?.hostKey;
  const diagnosticsInfo = paired.infoOf(diagnosticsHostKey);
  const diagnostics = useRtcDiagnostics(
    diagnosticsInfo?.phase === "ready" ? diagnosticsInfo.remote : undefined,
    connectionStatus(diagnosticsInfo) === "connected",
  );
  const status = (host: StoredHost): string => {
    const info = paired.info(host);
    if (connectionStatus(info) !== "connected") return hostStatusText(info);
    const path = diagnosticsHostKey === host.hostKey ? diagnostics?.path : undefined;
    return path === undefined ? "Connected" : `Connected · ${PATH_LABEL[path]}`;
  };

  if (detail !== undefined) {
    return (
      <HostDetail
        host={detail}
        status={status(detail)}
        diagnostics={diagnostics}
        rtcAvailable={rtcAvailable}
        hasBack={!settingsOwnsBack}
        onBack={closeDetail}
      />
    );
  }

  const accountState = account.state.status === "signed-in" ? account.state : undefined;
  const others = accountState === undefined ? [] : unpairedAccountHosts(accountState, paired.hosts);
  return (
    <VStack gap={4}>
      <HStack hAlign="end">
        <Button label="Add a host…" variant="secondary" size="sm" onClick={() => setAdding(true)} />
      </HStack>
      {accountState === undefined ? null : <AccountPairingBanners state={accountState} pairing={pairing} />}
      {paired.hosts.length === 0 ? (
        <Text type="supporting">No paired hosts.</Text>
      ) : (
        <SettingsGroup {...(others.length === 0 ? {} : { title: "Paired with this device" })}>
          <ul aria-label="Paired with this device" className={GROUP_ROWS}>
            {paired.hosts.map((host) => (
              <PairedHostRow
                key={host.hostKey}
                label={paired.label(host)}
                status={status(host)}
                connected={paired.isConnected(host)}
                isCurrent={paired.isCurrent(host)}
                issue={accountHostIssue(account.state, host.hostKey)}
                pairing={pairing}
                onSwitch={canSwitch ? () => paired.focusHost(host.hostKey) : undefined}
                onDetails={() => setDetailKey(host.hostKey)}
              />
            ))}
          </ul>
        </SettingsGroup>
      )}
      {accountState === undefined || others.length === 0 ? null : (
        <SettingsGroup title="On your account">
          <AccountHostList state={accountState} hosts={others} pairing={pairing} label="On your account" />
        </SettingsGroup>
      )}
      {adding ? <AddHostDialog onClose={() => setAdding(false)} /> : null}
    </VStack>
  );
}

/**
 * A host paired here: its status, the one thing to do about it — Pair again
 * when the account says it must, Switch on the one-shot screens, otherwise
 * nothing but the Current mark — and the way to its own page.
 */
function PairedHostRow({
  label,
  status,
  connected,
  isCurrent,
  issue,
  pairing,
  onSwitch,
  onDetails,
}: {
  label: string;
  status: string;
  connected: boolean;
  isCurrent: boolean;
  issue: AccountHostIssue | undefined;
  pairing: AccountPairing;
  onSwitch: (() => void) | undefined;
  onDetails: () => void;
}) {
  const hostId = issue?.match.host.hostId;
  const action =
    issue !== undefined ? (
      <Button
        label="Pair again"
        variant="secondary"
        size="sm"
        isLoading={pairing.pairing === hostId}
        isDisabled={issue.match.host.pairing !== "available" || pairing.pairing !== undefined}
        onClick={() => pairing.pair(issue.match.host.hostId)}
      />
    ) : onSwitch !== undefined ? (
      <Button label="Switch" aria-label={`Switch to ${label}`} variant="secondary" size="sm" onClick={onSwitch} />
    ) : isCurrent ? (
      <Token label="Current" size="sm" />
    ) : null;
  return (
    <li aria-label={label}>
      <Item
        as="div"
        startContent={<HostStatusDot connected={connected} />}
        descriptionLines={2}
        label={label}
        description={issue === undefined ? status : ACCOUNT_HOST_ISSUE[issue.kind]}
        endContent={
          <HStack gap={1} vAlign="center">
            {action}
            <IconButton
              label={`${label} details`}
              icon={<ChevronRight aria-hidden="true" />}
              variant="ghost"
              size="sm"
              onClick={onDetails}
            />
          </HStack>
        }
      />
    </li>
  );
}

/**
 * One paired host's page: how this device reaches it (mode, live path, the
 * routes it published), then the ways to let it go — unpair here, or take
 * it off the account entirely.
 */
function HostDetail({
  host,
  status,
  diagnostics,
  rtcAvailable,
  hasBack,
  onBack,
}: {
  host: StoredHost;
  status: string;
  diagnostics: RtcDiagnostics | undefined;
  rtcAvailable: boolean;
  /** False where the Settings header already carries the way back. */
  hasBack: boolean;
  onBack: () => void;
}) {
  const paired = usePairedHosts();
  const { setConnection } = useHosts();
  const account = useAccountModel();
  const [modeError, setModeError] = useState<string>();
  const [unpairing, setUnpairing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const label = paired.label(host);
  const info = paired.info(host);
  const connected = connectionStatus(info) === "connected";
  const hostMinor = info?.phase === "ready" ? info.view.host?.protocol.minor : undefined;
  const mode = host.connectionMode ?? "auto";
  const liveRemote = info?.phase === "ready" ? info.remote : undefined;
  const connectedSince = useRef(Date.now());
  useEffect(() => {
    connectedSince.current = Date.now();
  }, [liveRemote]);
  const accountMatch = account.state.status === "signed-in" ? accountHostFor(account.state, host.hostKey) : undefined;

  const changeMode = (next: ConnectionMode): void => {
    setModeError(undefined);
    void setConnection(host.hostKey, { connectionMode: next }).then(
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
        else live.remote.setConnectionMode(next);
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error("Could not store the host connection mode", error);
        setModeError(reason);
      },
    );
  };

  return (
    <VStack gap={5} role="group" aria-label={label}>
      <HStack gap={2} vAlign="center">
        {hasBack ? (
          <IconButton label="Back to hosts" icon={<ArrowLeft aria-hidden="true" />} variant="ghost" size="sm" onClick={onBack} />
        ) : null}
        <HostStatusDot connected={connected} />
        <VStack gap={0} className="min-w-0">
          {/* The Settings header names the host where it carries the way back. */}
          {hasBack ? <Heading level={3}>{label}</Heading> : null}
          <Text type="supporting">{status}</Text>
        </VStack>
      </HStack>
      <VStack gap={1}>
        <Text weight="semibold">Connection</Text>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <SegmentedControl
            className="shrink-0"
            value={mode}
            onChange={(next) => changeMode(next as ConnectionMode)}
            label="Connection mode"
            size="sm"
          >
            <SegmentedControlItem value="auto" label="Auto" />
            <SegmentedControlItem value="directOnly" label="Direct only" />
            <SegmentedControlItem value="relayOnly" label="Relay only" />
          </SegmentedControl>
        </HStack>
        <Text type="supporting">{MODE_HELP[mode]}</Text>
        {modeError === undefined ? null : (
          <Text type="supporting">{`Could not save the connection mode: ${modeError}`}</Text>
        )}
      </VStack>
      {connected ? (
        <SettingsGroup title="Status">
          <List hasDividers aria-label="Status">
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
                mode,
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
        </SettingsGroup>
      ) : null}
      <VStack gap={1}>
        <Text weight="semibold">Routes</Text>
        <HostRouteList host={host} routes={hostRoutes(host, { pageProtocol: window.location.protocol })} />
      </VStack>
      <HStack gap={2} wrap="wrap">
        <Button label="Unpair…" variant="secondary" size="sm" onClick={() => setUnpairing(true)} />
        {accountMatch === undefined ? null : (
          <Button label="Remove from account…" variant="secondary" size="sm" onClick={() => setRemoving(true)} />
        )}
      </HStack>
      {unpairing ? (
        <UnpairHostDialog
          host={host}
          label={label}
          info={info}
          onClose={(unpaired) => {
            setUnpairing(false);
            if (unpaired) onBack();
          }}
        />
      ) : null}
      {removing && accountMatch !== undefined && account.state.status === "signed-in" ? (
        <RemoveHostDialog
          account={account}
          hostId={accountMatch.host.hostId}
          name={accountMatch.host.name}
          serverOrigin={account.state.serverOrigin}
          onClose={(removed) => {
            setRemoving(false);
            if (removed) onBack();
          }}
        />
      ) : null}
    </VStack>
  );
}

/** Unpair, confirmed; the copy says how much the host will hear of it. */
function UnpairHostDialog({
  host,
  label,
  info,
  onClose,
}: {
  host: StoredHost;
  label: string;
  info: HostRuntimeInfo | undefined;
  onClose: (unpaired: boolean) => void;
}) {
  const { forget } = useHosts();
  const toast = useToast();
  const title = `Unpair ${label}?`;
  const unpair = (): void => {
    const remote = info?.phase === "ready" && connectionStatus(info) === "connected" ? info.remote : undefined;
    onClose(true);
    void unpairHost({ host, remote, forget }).then(
      ({ hostAnswered }) => {
        if (remote !== undefined && !hostAnswered) toast(unansweredUnpair(label));
      },
      (error: unknown) => console.error("Could not unpair the host", error),
    );
  };
  return (
    <Dialog aria-label={title} isOpen onOpenChange={(open) => (open ? undefined : onClose(false))} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title={title} subtitle={unpairText(label, info)} onOpenChange={() => onClose(false)} />}
        content={<LayoutContent />}
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={() => onClose(false)} />
              <Button label="Unpair" variant="destructive" onClick={unpair} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** What unpairing does depends on whether the host can still hear about it. */
function unpairText(label: string, info: HostRuntimeInfo | undefined): string {
  if (connectionStatus(info) === "connected") {
    return `${label} will stop accepting this device, and this device forgets it. Connecting again needs a new pairing link.`;
  }
  if (terminalReason(info) === "rejected") return `${label} no longer accepts this device. This removes it here.`;
  return `${label} isn't connected, so only this device forgets it. ${label} keeps listing this device until you unpair it under Settings → Devices there.`;
}

/**
 * The connection-failure screens repeat the device's hosts inline: a host
 * that can't be reached may need its connection mode changed. Inside the
 * frame the sidebar switches hosts; the one-shot pairing and token screens
 * have none, so they pass `canSwitch`. A host that refused
 * this device gets DeviceRejected instead, which carries its own way forward.
 */
export function HostsFallback({ canSwitch = false }: { canSwitch?: boolean }) {
  const account = useAccountModel();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <VStack gap={3} className="mt-4 w-full max-w-md">
      <HostsSection canSwitch={canSwitch} />
      {account.state.status === "unavailable" ? null : (
        <div>
          <Button label="Account…" variant="secondary" size="sm" onClick={() => setAccountOpen(true)} />
        </div>
      )}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </VStack>
  );
}
