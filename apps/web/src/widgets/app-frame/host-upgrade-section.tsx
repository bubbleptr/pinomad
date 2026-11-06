import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { relativeTime } from "@pinomad/client/family.ts";
import { hostSupportsCall, hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { AutoUpgradeMode, HostUpgrade, UpgradeBlocker, UpgradeWhen } from "@pinomad/protocol/upgrade.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { useNow } from "../../shared/use-now.ts";

/** "5m ago", "just now": `relativeTime` is the sidebar's compact form. */
const ago = (at: number, now: number): string => {
  const compact = relativeTime(at, now);
  return compact === "now" ? "just now" : `${compact} ago`;
};

/** How long a call may go unanswered before the page says so; the host may still act on it. */
export const CALL_TIMEOUT_MS = 30_000;

/** Rejects once `ms` pass without an answer, so a hung host never leaves the page silent. */
function answeredWithin(call: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The host didn't answer. It may still act on the request; this page updates when it does.")), ms);
  });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

type Pending = UpgradeWhen | "cancel" | "check";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What to run on the host instead, and why the button isn't here (ADR-0043 §4). */
const BLOCKED: Record<UpgradeBlocker, { title: string; description: string }> = {
  source: {
    title: "This host runs from a source checkout",
    description: "Upgrade it there with `bun run upgrade`.",
  },
  "no-service": {
    title: "This host isn't running as a service",
    description: "Nothing would start it again after an upgrade. Run `pinomad upgrade` on the host.",
  },
  stopped: {
    title: "This host's service is stopped",
    description: "Run `pinomad upgrade` on the host; the service stays off until you start it.",
  },
};

const AUTO_DESCRIPTIONS: Record<AutoUpgradeMode, string> = {
  off: "The host never checks for new releases.",
  notify: "The host checks every 6 hours and shows new releases here.",
  auto: "The host also installs a release once it's 3 days old and the host has been idle for 15 minutes. It never installs one that older apps can't connect to.",
};

/**
 * Settings → Upgrade (ADR-0043): the host's release, a newer one if npm has
 * it, and the upgrade in progress — all from the `upgrade` stream, so another
 * device starting or cancelling shows here too. The open confirmation is the
 * only local state. A host that can't upgrade itself shows the command to
 * run on it instead.
 */
export function HostUpgradeSection({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const minor = view.host?.protocol.minor ?? 0;
  const upgrade = view.upgrade;
  if (!hostSupportsCall(minor, "startUpgrade") || upgrade === null) {
    return (
      <Banner
        status="warning"
        title="This host is too old to upgrade from here"
        description="Run `pinomad upgrade` on the host."
      />
    );
  }
  const connected = view.connection === "connected";
  const mode = view.settings?.autoUpgrade;
  return (
    <VStack gap={4}>
      <UpgradeStatus upgrade={upgrade} remote={remote} connected={connected} checksOff={mode === "off"} />
      {mode === undefined || !hostSupportsFeature(minor, "autoUpgrade") ? null : (
        <AutoUpgradeSetting
          mode={mode}
          disabled={!connected}
          onChange={(next) => void remote.controller.updateSettings({ autoUpgrade: next })}
        />
      )}
    </VStack>
  );
}

function UpgradeStatus({
  upgrade,
  remote,
  connected,
  checksOff,
}: {
  upgrade: HostUpgrade;
  remote: RemoteDurable;
  connected: boolean;
  checksOff: boolean;
}) {
  const now = useNow(60_000);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const [error, setError] = useState<string>();
  // One call at a time; the confirmation closes only once the host answered.
  const act = (kind: Pending, action: () => Promise<void>, done?: () => void): void => {
    setError(undefined);
    setPending(kind);
    void answeredWithin(action(), CALL_TIMEOUT_MS)
      .then(done, (reason: unknown) => setError(errorText(reason)))
      .finally(() => setPending(undefined));
  };
  const start = (when: UpgradeWhen): void =>
    act(when, () => remote.controller.startUpgrade(when), () => setConfirming(false));
  const { available, phase, target, failure, blocked } = upgrade;
  const running = upgrade.current === null ? "Source checkout" : `pinomad ${upgrade.current}`;

  let summary: string;
  if (phase === "waiting") summary = `Upgrading to pinomad ${target ?? ""} once running tasks finish.`;
  else if (phase === "installing") summary = `Installing pinomad ${target ?? ""}… The host restarts when it's done.`;
  else if (available !== null) summary = `pinomad ${available.version} is available, released ${ago(available.publishedAt, now)}.`;
  else if (blocked === "source") summary = "Releases aren't checked for a source checkout.";
  // `checkedAt` also moves on a failed check: only a successful one says "up to date".
  else if (upgrade.checkError !== null) summary = "Unknown: the last check failed.";
  else if (upgrade.checkedAt !== null) summary = `Up to date. Checked ${ago(upgrade.checkedAt, now)}.`;
  else summary = checksOff ? "Release checks are off." : "Not checked yet.";

  const canStart = connected && blocked === null && phase === "idle" && available !== null;
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Text weight="semibold">{running}</Text>
        <Text type="supporting">{summary}</Text>
        {available !== null && available.crossesMajor && phase === "idle" ? (
          <Text type="supporting">Apps that haven't updated yet can't connect to this release.</Text>
        ) : null}
      </VStack>
      {upgrade.checkError === null ? null : (
        <Banner status="warning" title="Couldn't check for releases" description={upgrade.checkError} />
      )}
      {failure === null || phase !== "idle" ? null : (
        <Banner
          status="error"
          title={`Upgrading to pinomad ${failure.version} failed`}
          description={<span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{failure.message}</span>}
        />
      )}
      {blocked === null ? null : (
        <Banner status="info" title={BLOCKED[blocked].title} description={BLOCKED[blocked].description} />
      )}
      {error === undefined ? null : <Banner status="error" title="That didn't go through" description={error} />}
      {confirming && canStart ? (
        <UpgradeConfirm
          version={available.version}
          crossesMajor={available.crossesMajor}
          pending={pending === "idle" || pending === "now" ? pending : undefined}
          onCancel={() => setConfirming(false)}
          onStart={start}
        />
      ) : (
        <HStack gap={2} wrap="wrap">
          {phase === "waiting" ? (
            <Button
              label="Cancel upgrade"
              variant="secondary"
              size="sm"
              isDisabled={!connected || pending !== undefined}
              isLoading={pending === "cancel"}
              onClick={() => act("cancel", () => remote.controller.cancelUpgrade())}
            />
          ) : null}
          {canStart ? (
            <Button label="Upgrade…" variant="secondary" size="sm" onClick={() => setConfirming(true)} />
          ) : null}
          {/* A source checkout has no upgrader to ask. */}
          {phase === "idle" && blocked !== "source" ? (
            <Button
              label="Check now"
              variant="secondary"
              size="sm"
              isDisabled={!connected || checksOff || upgrade.checking || pending !== undefined}
              isLoading={upgrade.checking || pending === "check"}
              onClick={() => act("check", () => remote.controller.checkUpgrade())}
            />
          ) : null}
        </HStack>
      )}
    </VStack>
  );
}

function UpgradeConfirm({
  version,
  crossesMajor,
  pending,
  onCancel,
  onStart,
}: {
  version: string;
  crossesMajor: boolean;
  /** The choice sent and not yet answered. */
  pending: UpgradeWhen | undefined;
  onCancel: () => void;
  onStart: (when: UpgradeWhen) => void;
}) {
  const title = `Upgrade the host to pinomad ${version}?`;
  return (
    <VStack gap={2} role="group" aria-label={title}>
      <Text weight="semibold">{title}</Text>
      <Text type="supporting">
        The host restarts after installing, and every device reconnects. Open terminals close.
        {crossesMajor ? " Apps that haven't updated yet can't connect to this release." : ""}
      </Text>
      <Text type="supporting">Upgrading now interrupts running tasks; they continue after the restart.</Text>
      <HStack gap={2} hAlign="end" wrap="wrap">
        <Button label="Cancel" variant="secondary" size="sm" isDisabled={pending !== undefined} onClick={onCancel} />
        <Button
          label="Upgrade now"
          variant="secondary"
          size="sm"
          isDisabled={pending !== undefined}
          isLoading={pending === "now"}
          onClick={() => onStart("now")}
        />
        <Button
          label="Upgrade when idle"
          variant="primary"
          size="sm"
          isDisabled={pending !== undefined}
          isLoading={pending === "idle"}
          onClick={() => onStart("idle")}
        />
      </HStack>
    </VStack>
  );
}

function AutoUpgradeSetting({
  mode,
  disabled,
  onChange,
}: {
  mode: AutoUpgradeMode;
  disabled: boolean;
  onChange: (mode: AutoUpgradeMode) => void;
}) {
  return (
    <VStack gap={1}>
      <Text>Automatic upgrades</Text>
      {/* In an HStack the control hugs its items; a VStack would stretch it across the page. */}
      <HStack>
        <SegmentedControl
          className="shrink-0"
          value={mode}
          onChange={(next) => onChange(next as AutoUpgradeMode)}
          label="Automatic upgrades"
          size="sm"
          isDisabled={disabled}
        >
          <SegmentedControlItem value="off" label="Off" />
          <SegmentedControlItem value="notify" label="Notify" />
          <SegmentedControlItem value="auto" label="When idle" />
        </SegmentedControl>
      </HStack>
      <Text type="supporting">{AUTO_DESCRIPTIONS[mode]}</Text>
    </VStack>
  );
}
