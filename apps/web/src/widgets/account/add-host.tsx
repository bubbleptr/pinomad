import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import type { AccountError, JoinToken } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { localHostBridge, useLocalHostState } from "../../entities/local-host/use-local-host.ts";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";
import { HostLinkEntry } from "./host-link-entry.tsx";
import { joinCommand } from "./join-command.ts";
import { LocalHostSetup } from "./local-host-setup.tsx";

/**
 * How a new host joins this account (#496): the command to run on it, the
 * field for the code it then prints, and, folded away for scripts, the old
 * one-time token command that needs no confirmation. In the Mac app with no
 * host installed here, Set up this Mac does the same here, with no terminal
 * and no code (#501).
 * Shared by the account panel's Add a host and the first-host home.
 */
export function AddHostSteps({ serverOrigin }: { serverOrigin: string }) {
  const localHost = localHostBridge();
  const { state: localState, pollUntilInstalled } = useLocalHostState(localHost);
  return (
    <VStack gap={4} style={{ width: "100%" }}>
      <VStack gap={2}>
        <Text type="supporting">On the computer you want to add, open a terminal and run:</Text>
        {/* No language: shell highlighting splits the server address into colors. */}
        <CodeBlock code={joinCommand(serverOrigin)} hasCopyButton isWrapped width="100%" />
      </VStack>
      {localHost !== undefined && localState?.kind === "not-installed" ? (
        <VStack gap={2}>
          <Text type="supporting">Or set up this Mac, with no terminal:</Text>
          <LocalHostSetup bridge={localHost} serverOrigin={serverOrigin} onFinished={pollUntilInstalled} />
        </VStack>
      ) : null}
      <VStack gap={2}>
        <Text type="supporting">
          It asks how your other devices should reach the host; press Enter to go through this server. Then it opens a
          page to confirm the host, or, on a computer without a browser, prints a code. Enter that code here:
        </Text>
        {/* A host confirmed here may be this Mac, run from a terminal: Set up this Mac goes once it has installed. */}
        <HostLinkEntry onSettled={(outcome) => outcome === "confirmed" && pollUntilInstalled()} />
      </VStack>
      <TokenCommand />
    </VStack>
  );
}

/** The one-time token command, minted on first open: each one is single-use, so none is made unasked. */
function TokenCommand() {
  const account = useAccountModel();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<JoinToken>();
  const [error, setError] = useState<AccountError>();
  const [busy, setBusy] = useState(false);
  const create = (): void => {
    setBusy(true);
    setError(undefined);
    void account.createJoinToken().then((result) => {
      setBusy(false);
      if (result.ok) setToken(result.value);
      else setError(result.error);
    });
  };
  const toggle = (next: boolean): void => {
    setOpen(next);
    if (next && token === undefined && !busy) create();
  };
  return (
    <Collapsible
      trigger={<Text type="supporting">Advanced: join with a one-time token</Text>}
      isOpen={open}
      onOpenChange={toggle}
    >
      <VStack gap={2}>
        <Text type="supporting">For scripts: this command joins without a code to confirm. Anyone who has it can add a host.</Text>
        {token === undefined ? (
          error === undefined ? (
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" />
              <Text type="supporting">Creating a command…</Text>
            </HStack>
          ) : (
            <Banner
              status="error"
              title="Couldn't create a join command"
              description={accountErrorMessage(error)}
              endContent={<Button label="Try again" variant="secondary" isLoading={busy} onClick={create} />}
            />
          )
        ) : (
          <JoinCommand token={token} onRenew={create} />
        )}
        {token !== undefined && error !== undefined ? (
          <Banner status="error" title="Couldn't create a new command" description={accountErrorMessage(error)} />
        ) : null}
      </VStack>
    </Collapsible>
  );
}

/** A join command with its countdown; New command once it expires. */
export function JoinCommand({ token, onRenew }: { token: JoinToken; onRenew: () => void }) {
  const now = useNow(1000);
  const seconds = Math.max(0, Math.ceil((token.expiresAt - now) / 1000));
  return (
    <VStack gap={2}>
      {/* No language: shell highlighting splits the server address and token into colors. */}
      <CodeBlock code={token.command} hasCopyButton isWrapped width="100%" />
      {seconds === 0 ? (
        <HStack gap={2} vAlign="center">
          <Text type="supporting">Expired</Text>
          <Button label="New command" variant="secondary" size="sm" onClick={onRenew} />
        </HStack>
      ) : (
        <Text type="supporting" hasTabularNumbers>
          Works once · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </Text>
      )}
    </VStack>
  );
}

/**
 * "Add a host": signed in, the `pinomad join` command and the field for the
 * code it prints (#496), with a pairing link one click away; without an
 * account, the pairing link is the only way.
 */
export function AddHostDialog({ onClose }: { onClose: () => void }) {
  const account = useAccountModel();
  const state = account.state;
  const [pastingLink, setPastingLink] = useState(false);
  const close = (): void => {
    if (state.status === "signed-in") void account.refreshHosts();
    onClose();
  };
  const linkForm = (
    <VStack gap={2}>
      <Text type="supporting">Paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</Text>
      <PairingLinkForm />
    </VStack>
  );
  return (
    <Dialog aria-label="Add a host" isOpen onOpenChange={(open) => (open ? undefined : close())} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title="Add a host" onOpenChange={() => close()} />}
        content={
          <LayoutContent>
            <div style={{ padding: "var(--spacing-2)" }}>
              {state.status !== "signed-in" ? (
                linkForm
              ) : (
                <VStack gap={4}>
                  <AddHostSteps serverOrigin={state.serverOrigin} />
                  {pastingLink ? (
                    linkForm
                  ) : (
                    <HStack>
                      <Button label="Have a pairing link?" variant="ghost" size="sm" onClick={() => setPastingLink(true)} />
                    </HStack>
                  )}
                </VStack>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Done" variant="secondary" onClick={close} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
