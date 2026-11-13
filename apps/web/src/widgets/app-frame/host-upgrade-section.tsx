import { Button } from "../../shared/ui/button.tsx";
import { SegmentedControl, SegmentedControlItem } from "../../shared/ui/segmented-control.tsx";
import { useState } from "react";
import { relativeTime } from "@pinomad/client/family.ts";
import { hostSupportsCall, hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { AutoUpgradeMode, HostUpgrade, UpgradeBlocker, UpgradeWhen } from "@pinomad/protocol/upgrade.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { useNow } from "../../shared/use-now.ts";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/dialog.tsx";
import { GROUP_ROWS, SettingsRow } from "../../shared/ui/settings-group.tsx";
import { FormError } from "../../shared/ui/field.tsx";
import { useErrorToast } from "../../shared/ui/toast.tsx";

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
 * Settings → About → Version (ADR-0043): the rows of the Version group — the
 * host's release with its actions, and the automatic upgrade mode. Everything
 * comes from the `upgrade` stream, so another device starting or cancelling
 * shows here too. The confirmation dialog is the only local state. A host
 * that can't upgrade itself shows the command to run on it instead.
 */
export function HostUpgradeSection({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const minor = view.host?.protocol.minor ?? 0;
  const upgrade = view.upgrade;
  if (!hostSupportsCall(minor, "startUpgrade") || upgrade === null) {
    return (
      <div className="p-4">
        <Alert variant="warning">
          <AlertTitle>This host is too old to upgrade from here</AlertTitle>
          <AlertDescription>Run `pinomad upgrade` on the host.</AlertDescription>
        </Alert>
      </div>
    );
  }
  const connected = view.connection === "connected";
  const mode = view.settings?.autoUpgrade;
  return (
    <div className={GROUP_ROWS}>
      <UpgradeStatus upgrade={upgrade} remote={remote} connected={connected} checksOff={mode === "off"} />
      {mode === undefined || !hostSupportsFeature(minor, "autoUpgrade") ? null : (
        <SettingsRow label="Automatic upgrades" description={AUTO_DESCRIPTIONS[mode]}>
          <SegmentedControl
            value={mode}
            onValueChange={(next) => void remote.controller.updateSettings({ autoUpgrade: next as AutoUpgradeMode })}
            aria-label="Automatic upgrades"
            disabled={!connected}
          >
            <SegmentedControlItem value="off">Off</SegmentedControlItem>
            <SegmentedControlItem value="notify">Notify</SegmentedControlItem>
            <SegmentedControlItem value="auto">When idle</SegmentedControlItem>
          </SegmentedControl>
        </SettingsRow>
      )}
    </div>
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
  // A failed start shows in the confirmation; Cancel and Check now have no
  // place of their own, so theirs is a toast.
  const [error, setError] = useState<string>();
  const callError = useErrorToast();
  // One call at a time; the confirmation closes only once the host answered.
  const act = (kind: Pending, action: () => Promise<void>, fail: (message: string) => void, done?: () => void): void => {
    setError(undefined);
    callError.clear();
    setPending(kind);
    void answeredWithin(action(), CALL_TIMEOUT_MS)
      .then(done, (reason: unknown) => fail(errorText(reason)))
      .finally(() => setPending(undefined));
  };
  const start = (when: UpgradeWhen): void =>
    act(when, () => remote.controller.startUpgrade(when), setError, () => setConfirming(false));
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
  // Another device started or cancelled, or the host dropped: the dialog
  // closes for good rather than coming back on its own later.
  if (confirming && !canStart) setConfirming(false);
  const confirmPending = pending === "idle" || pending === "now" ? pending : undefined;
  const alerts = [
    upgrade.checkError === null ? null : (
      <Alert key="check" variant="warning"><AlertTitle>Couldn't check for releases</AlertTitle><AlertDescription>{upgrade.checkError}</AlertDescription></Alert>
    ),
    failure === null || phase !== "idle" ? null : (
      <Alert key="failure" variant="destructive">
        <AlertTitle>{`Upgrading to pinomad ${failure.version} failed`}</AlertTitle>
        <AlertDescription><span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{failure.message}</span></AlertDescription>
      </Alert>
    ),
    blocked === null ? null : (
      <Alert key="blocked" variant="info">
        <AlertTitle>{BLOCKED[blocked].title}</AlertTitle>
        <AlertDescription>{BLOCKED[blocked].description}</AlertDescription>
      </Alert>
    ),
  ].filter((alert) => alert !== null);
  return (
    <>
      <SettingsRow
        label={running}
        description={
          available !== null && available.crossesMajor && phase === "idle"
            ? `${summary} Apps that haven't updated yet can't connect to this release.`
            : summary
        }
      >
        {phase === "waiting" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!connected || pending !== undefined}
            loading={pending === "cancel"}
            onClick={() => act("cancel", () => remote.controller.cancelUpgrade(), (message) => callError.show(`Couldn't cancel the upgrade: ${message}`))}
          >
            Cancel upgrade
          </Button>
        ) : null}
        {/* A source checkout has no upgrader to ask. */}
        {phase === "idle" && blocked !== "source" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!connected || checksOff || upgrade.checking || pending !== undefined}
            loading={upgrade.checking || pending === "check"}
            onClick={() => act("check", () => remote.controller.checkUpgrade(), (message) => callError.show(`Couldn't check for releases: ${message}`))}
          >
            Check now
          </Button>
        ) : null}
        {canStart ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending !== undefined}
            onClick={() => {
              setError(undefined);
              setConfirming(true);
            }}
          >
            Upgrade
          </Button>
        ) : null}
      </SettingsRow>
      {alerts.length === 0 ? null : <div className="flex flex-col gap-2 p-4">{alerts}</div>}
      {confirming && canStart ? (
        <UpgradeDialog
          version={available.version}
          crossesMajor={available.crossesMajor}
          pending={confirmPending}
          error={error}
          onCancel={() => {
            setError(undefined);
            setConfirming(false);
          }}
          onStart={start}
        />
      ) : null}
    </>
  );
}

function UpgradeDialog({
  version,
  crossesMajor,
  pending,
  error,
  onCancel,
  onStart,
}: {
  version: string;
  crossesMajor: boolean;
  /** The choice sent and not yet answered: the dialog stays until the host answers. */
  pending: UpgradeWhen | undefined;
  error: string | undefined;
  onCancel: () => void;
  onStart: (when: UpgradeWhen) => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && pending === undefined) onCancel();
      }}
      disablePointerDismissal
    >
      <DialogContent className="w-[480px]" showCloseButton={pending === undefined}>
        <DialogHeader>
          <DialogTitle>{`Upgrade the host to pinomad ${version}?`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <DialogDescription>
            The host restarts after installing, and every device reconnects. Open terminals close.
            {crossesMajor ? " Apps that haven't updated yet can't connect to this release." : ""}
          </DialogDescription>
          <p className="m-0 text-xs/5 text-muted-foreground">Upgrading now interrupts running tasks; they continue after the restart.</p>
          <FormError>{error}</FormError>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="secondary" disabled={pending !== undefined} onClick={onCancel}>Cancel</Button>
          <Button variant="secondary" disabled={pending !== undefined} loading={pending === "now"} onClick={() => onStart("now")}>
            Upgrade now
          </Button>
          <Button variant="primary" disabled={pending !== undefined} loading={pending === "idle"} onClick={() => onStart("idle")}>
            Upgrade when idle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
