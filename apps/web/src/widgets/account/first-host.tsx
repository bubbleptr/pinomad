import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "../../shared/ui/link.tsx";
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
    <div className="flex flex-col gap-6" style={{ width: "100%", maxWidth: 520 }}>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl/7 font-semibold">Add your first host</h2>
        <span className="text-xs/5 text-muted-foreground">
          A host is the computer that runs your agents: a Mac or Linux machine. The command installs PiNomad with its
          own Node, joins the host to your account and keeps it running as a service. The host then shows up here and
          connects on its own.
        </span>
      </div>
      <AddHostSteps serverOrigin={state.serverOrigin} />
      {state.hostsError === undefined ? null : (
        <Banner status="warning" title="Couldn't check for new hosts" description={accountErrorMessage(state.hostsError)} />
      )}
      <div className="flex flex-col gap-2">
        <span className="text-xs/5 text-muted-foreground">
          Not using an account?{" "}
          <Link href={NO_ACCOUNT_DOCS} external>
            Pair a host directly
          </Link>
        </span>
        {pastingLink ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs/5 text-muted-foreground">Paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</span>
            <PairingLinkForm />
          </div>
        ) : (
          <div className="flex">
            <Button label="Have a pairing link?" variant="ghost" size="sm" onClick={() => setPastingLink(true)} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs/5 text-muted-foreground">
            Signed in as {state.user} on {new URL(state.serverOrigin).host}
          </span>
          <Button label="Account" variant="secondary" size="sm" onClick={() => setAccountOpen(true)} />
        </div>
      </div>
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
    </div>
  );
}
