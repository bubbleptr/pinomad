import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState } from "react";
import type { AccountError, JoinToken } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountState } from "../../entities/account/account-model.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { AccountDialog } from "./account-dialog.tsx";
import { accountErrorMessage, JoinCommand } from "./account-panel.tsx";

/** Where the docs explain pairing without an account. */
const NO_ACCOUNT_DOCS = "https://pinomad.si/docs/";

/**
 * The home of a signed-in client with no hosts at all (#492): the one-time
 * `pinomad join` command, ready to copy, with the paste-a-pairing-link form
 * one click away. NoHostLink shows it in place of the account panel and keeps
 * refreshing the host list; once the new host joins and comes online, the
 * model pairs it and App swaps this screen for the workbench.
 */
export function FirstHost({ state }: { state: Extract<AccountState, { status: "signed-in" }> }) {
  const account = useAccountModel();
  const [token, setToken] = useState<JoinToken>();
  const [error, setError] = useState<AccountError>();
  const [busy, setBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [pastingLink, setPastingLink] = useState(false);
  const create = (): void => {
    setBusy(true);
    setError(undefined);
    void account.createJoinToken().then((result) => {
      setBusy(false);
      if (result.ok) setToken(result.value);
      else setError(result.error);
    });
  };
  // Each command is single-use: StrictMode's second mount must not mint another.
  const minted = useRef(false);
  useEffect(() => {
    if (minted.current) return;
    minted.current = true;
    create();
  }, []);
  return (
    <VStack gap={6} style={{ width: "100%", maxWidth: 520 }}>
      <VStack gap={2}>
        <Heading level={2}>Add your first host</Heading>
        <Text type="supporting">
          A host is the computer that runs your agents: a Mac or Linux machine with Node 25 or later. Open a terminal
          there and run:
        </Text>
      </VStack>
      <VStack gap={2}>
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
              endContent={<Button label="Try again" variant="ghost" isLoading={busy} onClick={create} />}
            />
          )
        ) : (
          <JoinCommand token={token} onRenew={create} />
        )}
        {token !== undefined && error !== undefined ? (
          <Banner status="error" title="Couldn't create a new command" description={accountErrorMessage(error)} />
        ) : null}
        <Text type="supporting">
          It installs PiNomad, joins the host to your account and keeps it running as a service. The host then shows up
          here and connects on its own.
        </Text>
      </VStack>
      {state.hostsError === undefined ? null : (
        <Banner status="warning" title="Couldn't check for new hosts" description={accountErrorMessage(state.hostsError)} />
      )}
      <VStack gap={2}>
        <Text type="supporting">
          Not using an account?{" "}
          <Link href={NO_ACCOUNT_DOCS} isExternalLink>
            Pair a host directly
          </Link>
        </Text>
        {pastingLink ? (
          <VStack gap={2}>
            <Text type="supporting">Paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</Text>
            <PairingLinkForm />
          </VStack>
        ) : (
          <HStack>
            <Button label="Have a pairing link?" variant="ghost" size="sm" onClick={() => setPastingLink(true)} />
          </HStack>
        )}
        <HStack gap={2} vAlign="center">
          <Text type="supporting">
            Signed in as {state.user} on {new URL(state.serverOrigin).host}
          </Text>
          <Button label="Account…" variant="ghost" size="sm" onClick={() => setAccountOpen(true)} />
        </HStack>
      </VStack>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </VStack>
  );
}
