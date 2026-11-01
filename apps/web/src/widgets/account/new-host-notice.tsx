import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useEffect, useState } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { browserKnownHosts, type KnownHostsStore } from "../../entities/account/known-hosts.ts";
import { AccountDialog } from "./account-dialog.tsx";

/**
 * "New host X joined your account", once per host on this device (#496). A
 * host confirmed on any device pairs here on its own; this is where the user
 * learns that a machine they didn't add got in. The first host list after a
 * sign-in on this device only seeds the set.
 */
export function NewHostNotices({ knownHosts = browserKnownHosts }: { knownHosts?: KnownHostsStore }) {
  const { state } = useAccountModel();
  const toast = useToast();
  const [accountOpen, setAccountOpen] = useState(false);
  useEffect(() => {
    // A failed refresh republishes the previous list (an empty one before any
    // success): seeding from it would announce every host on the next success.
    if (state.status !== "signed-in" || state.hostsError !== undefined) return;
    const arrived = knownHosts.arrivals(
      { serverOrigin: state.serverOrigin, user: state.user },
      state.hosts.map((match) => match.host.hostId),
    );
    for (const hostId of arrived) {
      const name = state.hosts.find((match) => match.host.hostId === hostId)?.host.name ?? "A host";
      toast({
        body: `New host ${name} joined your account. Didn't add it? Check Account.`,
        uniqueID: `new-host:${hostId}`,
        // It may land while the user looks elsewhere; it waits to be read.
        isAutoHide: false,
        endContent: <Button label="Account" variant="ghost" size="sm" onClick={() => setAccountOpen(true)} />,
      });
    }
  }, [knownHosts, state, toast]);
  return accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null;
}
