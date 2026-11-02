import { useEffect, useRef, type RefObject } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { findConversation } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

export interface ConversationFocusOptions {
  /** The host's opening tracker; defaults to a direct controller switch. */
  open?: (id: ConversationId) => void;
  /** Forget an opening the reader left. */
  cancel?: () => void;
  /** A conversation this host had shown disappeared (archived or ended). */
  onUnavailable?: () => void;
  /**
   * Set while this host creates a fork from the focused conversation. The
   * fork command switches main without going through app focus, so a target
   * still pointing at the parent must not switch it back.
   */
  forkPending?: RefObject<boolean>;
  /** Adopt the fork the host switched to while the creation is pending. */
  onForkFollow?: (id: ConversationId) => void;
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
  const { open, cancel, onUnavailable, forkPending, onForkFollow } = options;
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
    // A fork command switches the host's main conversation on its own. While
    // that is in flight, adopt the new fork instead of pulling focus back to
    // the parent — but only when it is still the same parent (a reader who
    // moved away meanwhile wins).
    if (forkPending?.current === true && shown !== undefined) {
      const node = view.organized === undefined ? undefined : findConversation(view.organized, shown);
      if (node?.summary.kind === "fork" && node.summary.parent === target) {
        seen.current = shown;
        onForkFollow?.(shown);
        return;
      }
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
  }, [cancel, connected, forkPending, onForkFollow, onUnavailable, open, remote, shown, side, target, view.organized]);
}
