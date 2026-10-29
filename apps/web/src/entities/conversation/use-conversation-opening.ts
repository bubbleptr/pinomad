import { useCallback, useRef, useState } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";

/** A conversation the reader opened whose view has not landed, or whose switch failed. */
export type Opening = { id: ConversationId; failed: boolean };

/**
 * Open a conversation without waiting for it: the remote only shows a
 * conversation once its snapshot arrives, so the caller learns the target at
 * once and renders it as loading. The switch never rejects (the controller
 * turns errors into notices) — a switch that settles without showing the
 * conversation is the failure. Only the latest open counts.
 */
export function useConversationOpening(remote: RemoteDurable): {
  opening: Opening | undefined;
  open: (id: ConversationId) => void;
  cancel: () => void;
} {
  const [opening, setOpening] = useState<Opening>();
  const latest = useRef(0);
  const open = useCallback(
    (id: ConversationId) => {
      const attempt = ++latest.current;
      setOpening({ id, failed: false });
      void remote.controller.switchConversation(id).then(() => {
        if (attempt !== latest.current) return;
        const shown = remote.view.current().conversation?.conversation.id === id;
        setOpening(shown ? undefined : { id, failed: true });
      });
    },
    [remote],
  );
  const cancel = useCallback(() => {
    latest.current++;
    setOpening(undefined);
  }, []);
  return { opening, open, cancel };
}
