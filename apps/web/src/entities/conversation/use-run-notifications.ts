// Browser notifications driven by diffRunNotices. The baseline belongs to one
// host runtime and survives focus changes; only the conversation actually on
// screen is suppressed (ADR-0035 §9).
import { useEffect, useRef } from "react";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { inboxRunIds } from "@pinomad/client/inbox.ts";
import { diffRunNotices, type StatusBaseline } from "@pinomad/client/run-notifications.ts";
import type { ConversationRef } from "../host/focus.ts";
import { INBOX_MODE_ENABLED, inboxOfConversation } from "../inbox/inbox.ts";

export function useRunNotifications(
  view: DurableView,
  hostKey: string | undefined,
  visibleConversationId: number | undefined,
  open: (ref: ConversationRef) => void,
  enabled = true,
  inboxModeEnabled = INBOX_MODE_ENABLED,
): void {
  const baseline = useRef<StatusBaseline | undefined>(undefined);
  // The notifications still on screen, by conversation: a status move while
  // one is up (the question got answered, the run resumed) retires it rather
  // than leaving a stale call to action behind.
  const shown = useRef(new Map<number, Notification>());
  // `open` is a fresh closure every render; the diff effect must see the
  // latest without re-running on it.
  const openConversation = useRef(open);
  openConversation.current = open;
  useEffect(
    () => () => {
      // A forgotten host's runtime unmounts; its stale notices must not point
      // at a host the app no longer has.
      for (const notification of shown.current.values()) notification.close();
      shown.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    if (view.connection !== "connected") return;
    const { notices, changed, baseline: next } = diffRunNotices(baseline.current, view.organized, inboxRunIds(view.inbox));
    baseline.current = next;
    for (const id of changed) {
      shown.current.get(id)?.close();
      shown.current.delete(id);
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const source = hostKey ?? "local";
    for (const notice of notices) {
      // An open Inbox task's question is answered in its intake (#846), once the
      // intake exists; a closed task's questions do not show there.
      const owner = notice.body === "Waiting for your answer" ? inboxOfConversation(view.inbox, notice.id) : undefined;
      const target =
        inboxModeEnabled && owner?.task !== undefined && !owner.task.closed && owner.inbox.intake !== undefined
          ? owner.inbox.intake
          : notice.id;
      // The window is in front and the conversation that shows this is on screen.
      if (
        document.visibilityState === "visible"
        && document.hasFocus()
        && (visibleConversationId === notice.id || visibleConversationId === target)
      ) continue;
      const notification = new Notification(notice.title, {
        body: notice.body,
        // A host+conversation pair is the identity: the same numeric id on two
        // hosts is two different runs.
        tag: `pinomad-conversation-${source}-${notice.id}`,
      });
      shown.current.set(notice.id, notification);
      // Drop only this instance's entry — a replacement may already sit there.
      notification.onclose = () => {
        if (shown.current.get(notice.id) === notification) shown.current.delete(notice.id);
      };
      notification.onclick = () => {
        window.focus();
        openConversation.current({ hostKey: source, conversationId: target });
        notification.close();
        if (shown.current.get(notice.id) === notification) shown.current.delete(notice.id);
      };
    }
  }, [enabled, hostKey, visibleConversationId, view.connection, view.organized, view.inbox, inboxModeEnabled]);
}
