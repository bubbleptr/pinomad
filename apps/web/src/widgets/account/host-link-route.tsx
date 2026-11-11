import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { useState } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { AccountPanel } from "./account-panel.tsx";
import { HostLinkEntry, HostLinkRequestEntry } from "./host-link-entry.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

/**
 * The page `pinomad join <origin>` opens (the server's `verifyUrl`). Exact,
 * and of what follows only `?request=<id>` is read: the loopback request a
 * host on this computer opened it with (#513). A code is never read from
 * the address, only typed.
 */
export const HOST_LINK_PATH = "/host-link";

const requestIdIn = (search: string): string | undefined => {
  const id = new URLSearchParams(search).get("request");
  return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
};

/** Out of the address once the request is answered or dropped, so a reload doesn't reopen it. */
const leavePath = (): void => {
  if (window.location.pathname === HOST_LINK_PATH) history.replaceState(null, "", "/");
};

/**
 * The code entry over whatever screen App shows, when the page was opened at
 * /host-link. A signed-out visitor signs in here first and lands on the entry.
 */
export function HostLinkRoute({ navigate = (url) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const [open, setOpen] = useState(() => window.location.pathname === HOST_LINK_PATH);
  // Read once: the id must outlive the sign-in in between, and the address after it.
  const [requestId] = useState(() => (open ? requestIdIn(window.location.search) : undefined));
  if (!open) return null;
  const close = (): void => {
    leavePath();
    setOpen(false);
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="w-[480px]">
        <DialogHeader>
          <DialogTitle>Add a host</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div style={{ padding: "var(--spacing-2)" }}>
            <HostLinkSteps requestId={requestId} navigate={navigate} onSettled={leavePath} onClose={close} />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function HostLinkSteps({
  requestId,
  navigate,
  onSettled,
  onClose,
}: {
  requestId: string | undefined;
  navigate: (url: string) => void;
  onSettled: () => void;
  onClose: () => void;
}) {
  const { state } = useAccountModel();
  switch (state.status) {
    case "checking":
      return (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-xs/5 text-muted-foreground">Checking for an account…</span>
        </div>
      );
    case "unavailable":
      return (
        <div className="flex flex-col gap-3">
          <span className="text-sm/5">Confirm a host on the server it's joining: open the address its terminal printed.</span>
          <div className="flex">
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
      );
    case "signed-out":
      return (
        <div className="flex flex-col gap-3">
          <span className="text-xs/5 text-muted-foreground">
            {requestId === undefined
              ? "Sign in to the account the host is joining, then enter the code from its terminal."
              : "Sign in to the account the host is joining to confirm it."}
          </span>
          <AccountPanel />
        </div>
      );
    case "signed-in":
      if (requestId !== undefined) {
        return <HostLinkRequestEntry requestId={requestId} navigate={navigate} onSettled={onSettled} onClose={onClose} />;
      }
      return (
        <div className="flex flex-col gap-3">
          <span className="text-xs/5 text-muted-foreground">Enter the code the host's terminal shows to add it to {state.user}'s account.</span>
          <HostLinkEntry onSettled={onSettled} onClose={onClose} />
        </div>
      );
  }
}
