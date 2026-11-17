// What a transcript needs to draw Inbox cards (ADR-0051 §6): in a task's
// conversation, the events the worker delivered; in an intake, the tasks
// `inbox_submit` put into the Inbox. Provided around the main column only,
// so other transcripts (the side panel's subagents) draw plain entries.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Organized } from "@pinomad/protocol/organization.ts";
import type { HostInbox, InboxEvent, InboxTask } from "@pinomad/protocol/inbox.ts";
import { describeTasks, INBOX_MODE_ENABLED, inboxOfConversation, type InboxTaskInfo } from "./inbox.ts";

export interface InboxTranscript {
  /** Dormant history keeps its cards but offers no navigation into the mode. */
  readonly interactive: boolean;
  /** The shown task's events by id; empty outside a task's conversation. */
  readonly events: ReadonlyMap<string, InboxEvent>;
  /** A task of the shown conversation's Inbox, as it stands now. */
  readonly task: (taskId: string) => InboxTaskInfo | undefined;
  readonly openTask: (taskId: string) => void;
}

const InboxTranscriptContext = createContext<InboxTranscript | undefined>(undefined);

export const useInboxTranscript = (): InboxTranscript | undefined => useContext(InboxTranscriptContext);

/** Provides the Inbox around a transcript when the conversation belongs to one; otherwise renders the children alone. */
export function InboxTranscriptProvider({
  inbox,
  organized,
  conversationId,
  onOpenTask,
  interactive = INBOX_MODE_ENABLED,
  children,
}: {
  inbox: HostInbox | null;
  organized: Organized;
  conversationId: ConversationId | undefined;
  onOpenTask: (project: string, task: InboxTask) => void;
  interactive?: boolean;
  children: ReactNode;
}) {
  const found = inboxOfConversation(inbox, conversationId);
  const value = useMemo<InboxTranscript | undefined>(() => {
    if (found === undefined) return undefined;
    const described = describeTasks(found.inbox, organized);
    return {
      interactive,
      events: new Map((found.task?.events ?? []).map((event) => [event.id, event])),
      task: (taskId) => described.get(taskId),
      openTask: (taskId) => {
        const task = described.get(taskId)?.task;
        if (task !== undefined) onOpenTask(found.inbox.project, task);
      },
    };
  }, [found?.inbox, found?.task, organized, interactive, onOpenTask]);
  return <InboxTranscriptContext.Provider value={value}>{children}</InboxTranscriptContext.Provider>;
}
