// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/useChatNewMessages.ts (MIT).

import { useCallback, useEffect, useRef, useState } from "react";
import { observeResize, unobserveResize } from "./shared-resize-observer";

// =============================================================================
// Types
// =============================================================================

export interface UseChatNewMessagesOptions {
  /**
   * Whether the scroll is currently locked (following content).
   * When locked, new messages don't flag — the user is already at the bottom.
   */
  isLocked: boolean;

  /**
   * Called on every content height change (new message or streaming growth).
   * Use to trigger scroll-if-locked in the scroll hook.
   */
  onResize?: () => void;
}

export interface UseChatNewMessagesReturn {
  /** Whether new messages arrived while the scroll was unlocked. */
  hasNewMessages: boolean;

  /** Dismiss the new messages flag. */
  dismiss: () => void;

  /**
   * Callback ref to attach to the content element.
   * Handles late mount — observer attaches whenever the element appears.
   */
  contentRef: (el: HTMLElement | null) => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useChatNewMessages({
  isLocked,
  onResize,
}: UseChatNewMessagesOptions): UseChatNewMessagesReturn {
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const lastMessageRef = useRef<Element | null>(null);
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  // Track the current content element. When the callback ref fires,
  // we tear down the old observer and set up a new one.
  const elementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const attach = useCallback((el: HTMLElement) => {
    observeResize(el, () => {
      onResizeRef.current?.();

      const messages = el.querySelectorAll("[data-chat-message]");
      const last = messages.length > 0 ? messages[messages.length - 1] : null;

      if (last && last !== lastMessageRef.current) {
        lastMessageRef.current = last;
        if (!isLockedRef.current) {
          setHasNewMessages(true);
        }
      }
    });

    cleanupRef.current = () => unobserveResize(el);
  }, []);

  const detach = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  // Callback ref — handles mount, unmount, and element swap
  const contentRef = useCallback(
    (el: HTMLElement | null) => {
      if (el === elementRef.current) {
        return;
      }

      // Detach from previous element
      detach();
      elementRef.current = el;

      // Attach to new element
      if (el) {
        attach(el);
      }
    },
    [attach, detach],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => detach();
  }, [detach]);

  const dismiss = useCallback(() => {
    setHasNewMessages(false);
  }, []);

  return {hasNewMessages, dismiss, contentRef};
}
