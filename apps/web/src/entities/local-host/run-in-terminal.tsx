import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { useState } from "react";
import type { LocalHostBridge } from "./use-local-host.ts";

/**
 * Opens Terminal on a script that installs the host on this Mac and joins it
 * to `serverOrigin` with `pinomad up --code`; the user then types the code it
 * prints into the app's code field, which the caller renders.
 */
export function RunInTerminalButton({
  bridge,
  serverOrigin,
  onOpened,
}: {
  bridge: LocalHostBridge;
  serverOrigin: string;
  onOpened?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (): void => {
    setBusy(true);
    setError(undefined);
    void bridge
      .runSetup(serverOrigin)
      .catch((reason: unknown) => ({ ok: false as const, message: reason instanceof Error ? reason.message : String(reason) }))
      .then((result) => {
        setBusy(false);
        if (result.ok) onOpened?.();
        else setError(result.message);
      });
  };
  return (
    <VStack gap={2}>
      <HStack>
        <Button label="Run in Terminal" variant="secondary" isLoading={busy} onClick={run} />
      </HStack>
      {error === undefined ? null : <Banner status="error" title="Couldn't open Terminal" description={error} />}
    </VStack>
  );
}
