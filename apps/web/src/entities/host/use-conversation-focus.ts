import { useEffect, useRef } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

export interface ConversationFocusOptions {
  /** The host's opening tracker; defaults to a direct controller switch. */
  open?: (id: ConversationId) => void;
  /** Forget an opening the reader left. */
  cancel?: () => void;
  /** A conversation this host had shown disappeared (archived or ended). */
  onUnavailable?: () => void;
}

/**
 * Keep one host's conversation subscription on the focused ref. A host that
 * loses focus releases both main and side subscriptions (ADR-0035 §2); the
 * connection and its unsettled uploads/submissions stay untouched.
 */
export function useConversationFocus(
  remote: RemoteDurable,
  view: DurableView,
  target: ConversationId | undefined,
  options: ConversationFocusOptions = {},
): void {
  const { open, cancel, onUnavailable } = options;
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
      cancel?.();
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
    if (open !== undefined) open(target);
    else void remote.controller.switchConversation(target);
  }, [cancel, connected, onUnavailable, open, remote, shown, side, target]);
}
