// Browser notifications driven by diffRunNotices: silent while the window is
// in front, and frozen while the host connection is down so a run that ended
// during the outage still gets its notice after reconnect.
import { useEffect, useRef } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { diffRunNotices, type StatusBaseline } from "./run-notifications.ts";

export function useRunNotifications(remote: RemoteDurable, view: DurableView): void {
  const baseline = useRef<StatusBaseline | undefined>(undefined);
  useEffect(() => {
    if (view.connection !== "connected") return;
    const { notices, baseline: next } = diffRunNotices(baseline.current, view.organized);
    baseline.current = next;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const notice of notices) {
      // The window is in front: the change is already on screen.
      if (document.visibilityState === "visible" && document.hasFocus()) continue;
      const notification = new Notification(notice.title, {
        body: notice.body,
        // A conversation's newer notice replaces one still on screen for it.
        tag: `pinomad-conversation-${notice.id}`,
      });
      notification.onclick = () => {
        window.focus();
        void remote.controller.switchConversation(notice.id);
        notification.close();
      };
    }
  }, [remote, view.connection, view.organized]);
}
