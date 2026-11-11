import { Button } from "../../shared/ui/button.tsx";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

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
    <div className="flex flex-col gap-4" style={{ width: "100%" }}>
      <div className="flex flex-col gap-2">
        <span className="text-xs/5 text-muted-foreground">On the computer you want to add, open a terminal and run:</span>
        {/* No language: shell highlighting splits the server address into colors. */}
        <CodeBlock code={joinCommand(serverOrigin)} hasCopyButton isWrapped width="100%" />
      </div>
      {localHost !== undefined && localState?.kind === "not-installed" ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs/5 text-muted-foreground">Or set up this Mac, with no terminal:</span>
          <LocalHostSetup bridge={localHost} serverOrigin={serverOrigin} onFinished={pollUntilInstalled} />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="text-xs/5 text-muted-foreground">
          It asks how your other devices should reach the host; press Enter to go through this server. Then it opens a
          page to confirm the host, or, on a computer without a browser, prints a code. Enter that code here:
        </span>
        {/* A host confirmed here may be this Mac, run from a terminal: Set up this Mac goes once it has installed. */}
        <HostLinkEntry onSettled={(outcome) => outcome === "confirmed" && pollUntilInstalled()} />
      </div>
      <TokenCommand />
    </div>
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
      trigger={<span className="text-xs/5 font-normal text-muted-foreground">Advanced: join with a one-time token</span>}
      isOpen={open}
      onOpenChange={toggle}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs/5 text-muted-foreground">For scripts: this command joins without a code to confirm. Anyone who has it can add a host.</span>
        {token === undefined ? (
          error === undefined ? (
            <div className="flex items-center gap-2">
              <Spinner size="sm" />
              <span className="text-xs/5 text-muted-foreground">Creating a command…</span>
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>Couldn't create a join command</AlertTitle>
              <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
              <AlertAction><Button variant="secondary" loading={busy} onClick={create}>Try again</Button></AlertAction>
            </Alert>
          )
        ) : (
          <JoinCommand token={token} onRenew={create} />
        )}
        {token !== undefined && error !== undefined ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't create a new command</AlertTitle>
            <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </Collapsible>
  );
}

/** A join command with its countdown; New command once it expires. */
export function JoinCommand({ token, onRenew }: { token: JoinToken; onRenew: () => void }) {
  const now = useNow(1000);
  const seconds = Math.max(0, Math.ceil((token.expiresAt - now) / 1000));
  return (
    <div className="flex flex-col gap-2">
      {/* No language: shell highlighting splits the server address and token into colors. */}
      <CodeBlock code={token.command} hasCopyButton isWrapped width="100%" />
      {seconds === 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs/5 text-muted-foreground">Expired</span>
          <Button variant="secondary" size="sm" onClick={onRenew}>New command</Button>
        </div>
      ) : (
        <span className="text-xs/5 text-muted-foreground tabular-nums">
          Works once · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      )}
    </div>
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
    <div className="flex flex-col gap-2">
      <span className="text-xs/5 text-muted-foreground">Paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</span>
      <PairingLinkForm />
    </div>
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())} disablePointerDismissal>
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <DialogTitle>Add a host</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div style={{ padding: "var(--spacing-2)" }}>
            {state.status !== "signed-in" ? (
              linkForm
            ) : (
              <div className="flex flex-col gap-4">
                <AddHostSteps serverOrigin={state.serverOrigin} />
                {pastingLink ? (
                  linkForm
                ) : (
                  <div className="flex">
                    <Button variant="ghost" size="sm" onClick={() => setPastingLink(true)}>Have a pairing link?</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
