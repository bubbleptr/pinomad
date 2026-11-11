import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../shared/ui/alert-dialog.tsx";
import { Button } from "../../shared/ui/button.tsx";
import { Field, FieldContent, FieldDescription, FieldLabel } from "../../shared/ui/field.tsx";
import { Switch } from "../../shared/ui/switch.tsx";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { LocalHostStopResult } from "../../entities/local-host/local-host-protocol.ts";
import { localHostBridge, useLocalHostState, type LocalHostBridge } from "../../entities/local-host/use-local-host.ts";
import { LocalHostSetup } from "../account/local-host-setup.tsx";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

/**
 * Settings → This Mac, desktop on macOS only (#501): a switch over the host
 * the user installed with the install script or npm. The app runs that
 * install's `pinomad service` (ADR-0003 §2, ADR-0017) and shows its real
 * state; with nothing installed it sets one up instead.
 */
export function LocalHostSection({ pollIntervalMs }: { pollIntervalMs?: number }) {
  const bridge = localHostBridge();
  if (bridge === undefined) return null;
  return <LocalHostControls bridge={bridge} pollIntervalMs={pollIntervalMs} />;
}

type Busy = { readonly kind: "starting" } | { readonly kind: "stopping"; readonly lines: readonly string[] };

function LocalHostControls({ bridge, pollIntervalMs }: { bridge: LocalHostBridge; pollIntervalMs: number | undefined }) {
  const { state, refresh, pollUntilInstalled } = useLocalHostState(bridge, pollIntervalMs);
  const [busy, setBusy] = useState<Busy>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  // The stop outlives this view (main runs it); only the line subscription goes with it.
  const unsubscribe = useRef<() => void>(undefined);
  useEffect(() => () => unsubscribe.current?.(), []);

  const start = (): void => {
    setBusy({ kind: "starting" });
    setError(undefined);
    void bridge
      .start()
      .catch((reason: unknown) => ({ ok: false as const, message: messageOf(reason) }))
      .then(async (result) => {
        if (!result.ok) setError(result.message);
        await refresh();
        setBusy(undefined);
      });
  };

  const watchStop = (run: () => Promise<LocalHostStopResult | undefined>): void => {
    setBusy({ kind: "stopping", lines: [] });
    setError(undefined);
    unsubscribe.current?.();
    unsubscribe.current = bridge.onStopLines((lines) =>
      setBusy((current) => (current?.kind === "stopping" ? { ...current, lines } : current)),
    );
    void run()
      .catch((reason: unknown) => ({ outcome: "failed" as const, message: messageOf(reason) }))
      .then(async (result) => {
        unsubscribe.current?.();
        unsubscribe.current = undefined;
        if (result?.outcome === "failed") setError(result.message);
        await refresh();
        setBusy(undefined);
      });
  };

  const stop = (): void => {
    setConfirming(false);
    watchStop(() => bridge.stop());
  };

  // Back in This Mac while a stop this app started still waits for tasks:
  // follow it, so Cancel is there again. Following never starts one.
  const resumable = state?.kind === "installed" && state.stopping && busy === undefined;
  useEffect(() => {
    if (resumable) watchStop(() => bridge.followStop());
  }, [resumable]);

  if (state === undefined) {
    return (
      <div className="flex items-center gap-2">
        <Spinner size="sm" />
        <span className="text-xs/5 text-muted-foreground">Checking this Mac…</span>
      </div>
    );
  }

  const banner =
    error === undefined ? null : (
      <Alert variant="destructive"><AlertTitle>Couldn't change the host</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
    );

  switch (state.kind) {
    case "error":
      return (
        <Alert variant="destructive">
          <AlertTitle>Couldn't check the host on this Mac</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
          <AlertAction><Button variant="secondary" onClick={() => void refresh()}>Try again</Button></AlertAction>
        </Alert>
      );
    case "too-old":
      return (
        <p className="text-xs/5 text-muted-foreground">
          The PiNomad host on this Mac is too old for this switch. Run pinomad upgrade in Terminal, then come back here.
        </p>
      );
    case "not-installed":
      return <NotInstalled bridge={bridge} onFinished={pollUntilInstalled} />;
    case "installed":
      return (
        <div className="flex flex-col gap-3">
          <Field orientation="horizontal" disabled={busy !== undefined}>
            <FieldContent>
              <FieldLabel>Run the host on this Mac</FieldLabel>
              <FieldDescription>{state.detail}</FieldDescription>
            </FieldContent>
            <Switch
              // On means not turned off: a crashed host launchd will restart is still on, and Off must reach it.
              checked={!state.stopped}
              aria-busy={busy !== undefined || undefined}
              // Off goes through the confirm; the switch keeps showing the real state until the CLI is done.
              onCheckedChange={(checked) => (checked ? start() : setConfirming(true))}
            />
          </Field>
          {busy?.kind === "stopping" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs/5 text-muted-foreground">
                Stopping…
              </p>
              {busy.lines.length === 0 ? null : (
                // The CLI's own lines, indentation kept: which tasks it is waiting for.
                <div role="log" aria-label="Stop progress" style={STOP_LOG}>
                  {busy.lines.map((line, index) => (
                    <div key={index}>{line}</div>
                  ))}
                </div>
              )}
              <div className="flex">
                {/* Interrupts the CLI's wait: the service stays on. */}
                <Button variant="secondary" size="sm" onClick={() => void bridge.cancelStop()}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {banner}
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Turn off the host on this Mac?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your other devices can't reach this Mac while it's off. Running tasks finish first, so this may take a while.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel />
                <AlertDialogAction variant="destructive" onClick={stop}>Turn off</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      );
  }
}

/** Nothing installed: set it up here, joined to the signed-in account. */
function NotInstalled({ bridge, onFinished }: { bridge: LocalHostBridge; onFinished: () => void }) {
  const account = useAccountModel();
  if (account.state.status !== "signed-in") {
    return (
      <p className="text-xs/5 text-muted-foreground">
        The PiNomad host isn't installed on this Mac. Sign in to your account first: the host joins it while it installs.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs/5 text-muted-foreground">
        The PiNomad host isn't installed on this Mac. Setting it up downloads PiNomad with its own Node, joins it to your
        account, and adds the pinomad command to your shell profile.
      </p>
      <LocalHostSetup bridge={bridge} serverOrigin={account.state.serverOrigin} onFinished={onFinished} />
    </div>
  );
}

const STOP_LOG: CSSProperties = {
  fontFamily: "var(--font-family-code)",
  fontSize: "var(--font-size-sm)",
  color: "var(--color-text-secondary)",
  whiteSpace: "pre-wrap",
};

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));
