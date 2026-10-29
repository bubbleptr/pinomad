import { useEffect, useRef } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

/**
 * Keep one host's conversation subscription on the focused ref. A host that
 * loses focus releases both main and side subscriptions (ADR-0035 §2); the
 * connection and its unsettled uploads/submissions stay untouched.
 *
 * `onUnavailable` fires when a conversation the host had shown disappears
 * (archived here or ended by the host). Clearing focus then keeps the effect
 * from switching the archived id straight back open.
 */
export function useConversationFocus(
  remote: RemoteDurable,
  view: DurableView,
  target: ConversationId | undefined,
  onUnavailable?: () => void,
): void {
  const connected = view.connection === "connected";
  const shown = view.conversation?.conversation.id;
  const side = view.side?.id;
  // The target this host actually displayed. Only a target that vanished
  // after being shown is an archive/unsubscribe, not a switch still landing.
  const seen = useRef<ConversationId | undefined>(undefined);
  useEffect(() => {
    if (!connected) return;
    if (target === undefined) {
      seen.current = undefined;
      if (shown !== undefined || side !== undefined) void remote.controller.clearConversation();
      return;
    }
    if (shown === target) {
      seen.current = target;
      return;
    }
    if (seen.current === target && shown === undefined) {
      seen.current = undefined;
      onUnavailable?.();
      return;
    }
    void remote.controller.switchConversation(target);
  }, [connected, onUnavailable, remote, shown, side, target]);
}
