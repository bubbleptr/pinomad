import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useState, type CSSProperties } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { RunInTerminalButton } from "../../entities/local-host/run-in-terminal.tsx";
import { localHostBridge, useLocalHostState, type LocalHostBridge } from "../../entities/local-host/use-local-host.ts";
import { HostLinkEntry } from "../account/host-link-entry.tsx";

/**
 * Settings → This Mac, desktop on macOS only (#501): a switch over the host
 * the user installed with the install script or npm. The app runs that
 * install's `pinomad service` (ADR-0003 §2, ADR-0017) and shows its real
 * state; with nothing installed it offers Run in Terminal instead.
 */
export function LocalHostSection() {
  const bridge = localHostBridge();
  if (bridge === undefined) return null;
  return <LocalHostControls bridge={bridge} />;
}

type Busy = { readonly kind: "starting" } | { readonly kind: "stopping"; readonly lines: readonly string[] };

function LocalHostControls({ bridge }: { bridge: LocalHostBridge }) {
  const { state, refresh } = useLocalHostState(bridge);
  const [busy, setBusy] = useState<Busy>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

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

  const stop = (): void => {
    setConfirming(false);
    setBusy({ kind: "stopping", lines: [] });
    setError(undefined);
    const off = bridge.onStopLine((line) =>
      setBusy((current) => (current?.kind === "stopping" ? { ...current, lines: [...current.lines, line] } : current)),
    );
    void bridge
      .stop()
      .catch((reason: unknown) => ({ outcome: "failed" as const, message: messageOf(reason) }))
      .then(async (result) => {
        off();
        if (result.outcome === "failed") setError(result.message);
        await refresh();
        setBusy(undefined);
      });
  };

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
      return <NotInstalled bridge={bridge} />;
    case "installed":
      return (
        <VStack gap={3}>
          <Switch
            label="Run the host on this Mac"
            description={state.detail}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
            value={state.running}
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
function NotInstalled({ bridge }: { bridge: LocalHostBridge }) {
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
          <HostLinkEntry />
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

const messageOf =(reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));
