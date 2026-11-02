import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import type { AccountState } from "../../entities/account/account-model.ts";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { accountErrorMessage } from "./account-error.ts";
import { AccountDialog } from "./account-dialog.tsx";
import { AddHostSteps } from "./add-host.tsx";

/** Where the docs explain pairing without an account. */
const NO_ACCOUNT_DOCS = "https://pinomad.si/docs/";

/**
 * The home of a signed-in client with no hosts at all (#492): the
 * `pinomad join` command and the field for the code it prints (#496), with
 * the paste-a-pairing-link form one click away. NoHostLink shows it in place
 * of the account panel and keeps refreshing the host list; once the new host
 * joins and comes online, the model pairs it and App swaps this screen for
 * the workbench.
 */
export function FirstHost({ state }: { state: Extract<AccountState, { status: "signed-in" }> }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [pastingLink, setPastingLink] = useState(false);
  return (
    <VStack gap={6} style={{ width: "100%", maxWidth: 520 }}>
      <VStack gap={2}>
        <Heading level={2}>Add your first host</Heading>
        <Text type="supporting">
          A host is the computer that runs your agents: a Mac or Linux machine. The command installs PiNomad with its
          own Node, joins the host to your account and keeps it running as a service. The host then shows up here and
          connects on its own.
        </Text>
      </VStack>
      <AddHostSteps serverOrigin={state.serverOrigin} />
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
