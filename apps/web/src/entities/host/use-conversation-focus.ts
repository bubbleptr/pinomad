import { useEffect } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

/**
 * Keep one host's conversation subscription on the focused ref. A host that
 * loses focus releases both main and side subscriptions (ADR-0035 §2); the
 * connection and its unsettled uploads/submissions stay untouched.
 */
export function useConversationFocus(
  remote: RemoteDurable,
  view: DurableView,
  target: ConversationId | undefined,
): void {
  const connected = view.connection === "connected";
  const shown = view.conversation?.conversation.id;
  const side = view.side?.id;
  useEffect(() => {
    if (!connected) return;
    if (target === undefined) {
      if (shown !== undefined || side !== undefined) void remote.controller.clearConversation();
      return;
    }
    if (shown !== target) void remote.controller.switchConversation(target);
  }, [connected, remote, shown, side, target]);
}
