import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useEffect } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { PairingLinkForm } from "../../entities/host/pairing-link-form.tsx";
import { AccountPanel } from "./account-panel.tsx";
import { FirstHost } from "./first-host.tsx";

/**
 * The model refreshes the account's hosts only on sign-in and on a return to
 * the foreground; a join command running in a terminal beside this window
 * never hides it. So this screen asks on its own.
 */
export const HOST_REFRESH_MS = 10_000;

/**
 * Where a client with no stored pairing lands: sign in to pick a host from
 * the account (where this client can reach one), or paste a pairing link.
 * An account with no hosts at all gets the add-your-first-host home instead;
 * one whose hosts are only offline or unpaired keeps the panel to pair them.
 *
 * While signed in it refreshes the account's hosts until App leaves this
 * screen, which happens once a host is paired on this device: a host that
 * joined offline is paired by the refresh after it comes online.
 */
export function NoHostLink() {
  const account = useAccountModel();
  const signedIn = account.state.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void account.refreshHosts();
    }, HOST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [account, signedIn]);
  if (account.state.status === "signed-in" && account.state.hosts.length === 0) {
    return <FirstHost state={account.state} />;
  }
  if (account.state.status === "unavailable") {
    return (
      <div className="flex flex-col items-center gap-4" style={{ width: "100%", maxWidth: 420 }}>
        <EmptyState
          title="No host link"
          description="Paste a pairing link from pinomad pair or Settings → Devices → Pair a device."
        />
        <PairingLinkForm />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" style={{ width: "100%", maxWidth: 420 }}>
      <AccountPanel initialPage="hosts" />
      <div className="flex flex-col gap-2">
        <span className="text-xs/5 text-muted-foreground">Or paste a pairing link from pinomad pair or Settings → Devices → Pair a device.</span>
        <PairingLinkForm />
      </div>
    </div>
  );
}
