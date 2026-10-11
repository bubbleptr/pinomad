// Browser notifications driven by diffRunNotices: silent while the window is
// in front, and frozen while the host connection is down so a run that ended
// during the outage still gets its notice after reconnect.
import { useEffect, useRef } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { diffRunNotices, type StatusBaseline } from "@pinomad/client/run-notifications.ts";

export function useRunNotifications(view: DurableView, open: (id: ConversationId) => void): void {
  const baseline = useRef<StatusBaseline | undefined>(undefined);
  // The notifications still on screen, by conversation: a status move while
  // one is up (the question got answered, the run resumed) retires it rather
  // than leaving a stale call to action behind.
  const shown = useRef(new Map<ConversationId, Notification>());
  // `open` is a fresh closure every render; the diff effect must see the
  // latest without re-running on it.
  const openConversation = useRef(open);
  openConversation.current = open;
  useEffect(() => {
    if (view.connection !== "connected") return;
    const { notices, changed, baseline: next } = diffRunNotices(baseline.current, view.organized);
    baseline.current = next;
    for (const id of changed) {
      shown.current.get(id)?.close();
      shown.current.delete(id);
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const notice of notices) {
      // The window is in front: the change is already on screen.
      if (document.visibilityState === "visible" && document.hasFocus()) continue;
      const notification = new Notification(notice.title, {
        body: notice.body,
        // A conversation's newer notice replaces one still on screen for it.
        tag: `pinomad-conversation-${notice.id}`,
      });
      shown.current.set(notice.id, notification);
      // Drop only this instance's entry — a replacement may already sit there.
      notification.onclose = () => {
        if (shown.current.get(notice.id) === notification) shown.current.delete(notice.id);
      };
      notification.onclick = () => {
        window.focus();
        openConversation.current(notice.id);
        notification.close();
        if (shown.current.get(notice.id) === notification) shown.current.delete(notice.id);
      };
    }
  }, [view.connection, view.organized]);
}
