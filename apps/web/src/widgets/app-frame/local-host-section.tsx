import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { RunInTerminalButton } from "../../entities/local-host/run-in-terminal.tsx";
import type { LocalHostStopResult } from "../../entities/local-host/local-host-protocol.ts";
import { localHostBridge, useLocalHostState, type LocalHostBridge } from "../../entities/local-host/use-local-host.ts";
import { HostLinkEntry } from "../account/host-link-entry.tsx";

/**
 * Settings → This Mac, desktop on macOS only (#501): a switch over the host
 * the user installed with the install script or npm. The app runs that
 * install's `pinomad service` (ADR-0003 §2, ADR-0017) and shows its real
 * state; with nothing installed it offers Run in Terminal instead.
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
      <HStack gap={2} vAlign="center">
        <Spinner size="sm" />
        <Text type="supporting">Checking this Mac…</Text>
      </HStack>
    );
  }

  const banner =
    error === undefined ? null : (
      <Banner status="error" title="Couldn't change the host" description={error} />
    );

  switch (state.kind) {
    case "error":
      return (
        <Banner
          status="error"
          title="Couldn't check the host on this Mac"
          description={state.message}
          endContent={<Button label="Try again" variant="ghost" onClick={() => void refresh()} />}
        />
      );
    case "too-old":
      return (
        <Text as="p" type="supporting">
          The PiNomad host on this Mac is too old for this switch. Run pinomad upgrade in Terminal, then come back here.
        </Text>
      );
    case "not-installed":
      return <NotInstalled bridge={bridge} onConfirmed={pollUntilInstalled} />;
    case "installed":
      return (
        <VStack gap={3}>
          <Switch
            label="Run the host on this Mac"
            description={state.detail}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
            // On means not turned off: a crashed host launchd will restart is still on, and Off must reach it.
            value={!state.stopped}
            isLoading={busy !== undefined}
            isDisabled={busy !== undefined}
            // Off goes through the confirm; the switch keeps showing the real state until the CLI is done.
            onChange={(checked) => (checked ? start() : setConfirming(true))}
          />
          {busy?.kind === "stopping" ? (
            <VStack gap={2}>
              <Text as="p" type="supporting">
                Stopping…
              </Text>
              {busy.lines.length === 0 ? null : (
                // The CLI's own lines, indentation kept: which tasks it is waiting for.
                <div role="log" aria-label="Stop progress" style={STOP_LOG}>
                  {busy.lines.map((line, index) => (
                    <div key={index}>{line}</div>
                  ))}
                </div>
              )}
              <HStack>
                {/* Interrupts the CLI's wait: the service stays on. */}
                <Button label="Cancel" variant="secondary" size="sm" onClick={() => void bridge.cancelStop()} />
              </HStack>
            </VStack>
          ) : null}
          {banner}
          <AlertDialog
            isOpen={confirming}
            onOpenChange={setConfirming}
            title="Turn off the host on this Mac?"
            description="Your other devices can't reach this Mac while it's off. Running tasks finish first, so this may take a while."
            actionLabel="Turn off"
            onAction={stop}
          />
        </VStack>
      );
  }
}

/** Nothing installed: Run in Terminal, then the field for the code `pinomad up --code` prints. */
function NotInstalled({ bridge, onConfirmed }: { bridge: LocalHostBridge; onConfirmed: () => void }) {
  const account = useAccountModel();
  const [opened, setOpened] = useState(false);
  if (account.state.status !== "signed-in") {
    return (
      <Text as="p" type="supporting">
        The PiNomad host isn't installed on this Mac. Sign in to your account first: the host joins it while it installs.
      </Text>
    );
  }
  return (
    <VStack gap={4}>
      <VStack gap={2}>
        <Text as="p" type="supporting">
          The PiNomad host isn't installed on this Mac. Install it in Terminal; it joins your account when it's done.
        </Text>
        <RunInTerminalButton bridge={bridge} serverOrigin={account.state.serverOrigin} onOpened={() => setOpened(true)} />
      </VStack>
      {opened ? (
        <VStack gap={2}>
          <Text as="p" type="supporting">
            When Terminal shows a code, enter it here:
          </Text>
          <HostLinkEntry onSettled={(outcome) => outcome === "confirmed" && onConfirmed()} />
        </VStack>
      ) : null}
    </VStack>
  );
}

const STOP_LOG: CSSProperties = {
  fontFamily: "var(--font-family-code)",
  fontSize: "var(--font-size-sm)",
  color: "var(--color-text-secondary)",
  whiteSpace: "pre-wrap",
};

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));
