import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { AccountPanel } from "./account-panel.tsx";
import { HostLinkEntry } from "./host-link-entry.tsx";

/** The page `pinomad join <origin>` opens (the server's `verifyUrl`). Exact: nothing after it is ever read. */
export const HOST_LINK_PATH = "/host-link";

/** Out of the address once the request is answered or dropped, so a reload doesn't reopen it. */
const leavePath = (): void => {
  if (window.location.pathname === HOST_LINK_PATH) history.replaceState(null, "", "/");
};

/**
 * The code entry over whatever screen App shows, when the page was opened at
 * /host-link. A signed-out visitor signs in here first and lands on the entry.
 */
export function HostLinkRoute() {
  const [open, setOpen] = useState(() => window.location.pathname === HOST_LINK_PATH);
  if (!open) return null;
  const close = (): void => {
    leavePath();
    setOpen(false);
  };
  return (
    <Dialog isOpen onOpenChange={(next) => (next ? undefined : close())} width={480}>
      <Layout
        header={<DialogHeader title="Add a host" onOpenChange={close} />}
        content={
          <LayoutContent>
            <div style={{ padding: "var(--spacing-2)" }}>
              <HostLinkSteps onSettled={leavePath} onClose={close} />
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function HostLinkSteps({ onSettled, onClose }: { onSettled: () => void; onClose: () => void }) {
  const { state } = useAccountModel();
  switch (state.status) {
    case "checking":
      return (
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text type="supporting">Checking for an account…</Text>
        </HStack>
      );
    case "unavailable":
      return (
        <VStack gap={3}>
          <Text>Confirm a host on the server it's joining: open the address its terminal printed.</Text>
          <HStack>
            <Button label="Close" variant="secondary" onClick={onClose} />
          </HStack>
        </VStack>
      );
    case "signed-out":
      return (
        <VStack gap={3}>
          <Text type="supporting">Sign in to the account the host is joining, then enter the code from its terminal.</Text>
          <AccountPanel />
        </VStack>
      );
    case "signed-in":
      return (
        <VStack gap={3}>
          <Text type="supporting">Enter the code the host's terminal shows to add it to {state.user}'s account.</Text>
          <HostLinkEntry onSettled={onSettled} onClose={onClose} />
        </VStack>
      );
  }
}
