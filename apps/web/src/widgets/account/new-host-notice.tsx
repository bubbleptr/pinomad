import { Button } from "../../shared/ui/button.tsx";
import { useEffect, useRef, useState } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { browserKnownHosts, type KnownHostsStore } from "../../entities/account/known-hosts.ts";
import { useToast } from "../../shared/ui/toast.tsx";
import { RemoveHostDialog } from "./remove-host.tsx";

/**
 * "New host X joined your account", once per host on this device (#496). A
 * host confirmed on any device pairs here on its own; this is where the user
 * learns that a machine they didn't add got in, and can take it off the
 * account right from the notice (#512). The first host list after a sign-in
 * on this device only seeds the set.
 */
export function NewHostNotices({ knownHosts = browserKnownHosts }: { knownHosts?: KnownHostsStore }) {
  const account = useAccountModel();
  const { state } = account;
  const toast = useToast();
  const [removing, setRemoving] = useState<{ hostId: string; name: string }>();
  /** Each notice's dismiss, so a removal takes its notice with it. */
  const dismissals = useRef(new Map<string, () => void>());
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
      const dismiss = toast({
        description: `New host ${name} joined your account. Didn't add it? Remove it.`,
        id: `new-host:${hostId}`,
        // It may land while the user looks elsewhere; it waits to be read.
        timeout: 0,
        action: <Button variant="secondary" size="sm" onClick={() => setRemoving({ hostId, name })}>Remove</Button>,
        onClose: () => dismissals.current.delete(hostId),
      });
      dismissals.current.set(hostId, dismiss);
    }
  }, [knownHosts, state, toast]);
  if (removing === undefined || state.status !== "signed-in") return null;
  return (
    <RemoveHostDialog
      account={account}
      hostId={removing.hostId}
      name={removing.name}
      serverOrigin={state.serverOrigin}
      onClose={(removed) => {
        if (removed) dismissals.current.get(removing.hostId)?.();
        setRemoving(undefined);
      }}
    />
  );
}
