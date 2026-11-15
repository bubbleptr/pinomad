// Inbox mode (5.38, ADR-0051): each project's Inbox as clients see it — its
// tasks and their events, the user's rules, the follow-ups and schedules not
// yet fired, and the project's intake conversation.
import type { ConversationId } from "@earendil-works/pi-durable";

/** Where an event came from: `user`, `schedule`, `followUp`, `webhook`, or `plugin:<name>`. */
export type InboxEventSource = string;

export interface InboxEvent {
  /** The source's id, unique within the Inbox. */
  readonly id: string;
  readonly source: InboxEventSource;
  /** The thread it belongs to (`github:acme/web#412`), when its source has one. */
  readonly thread?: string;
  /** A summary and pointers, never the full content (ADR-0051 §5). */
  readonly summary: string;
  /** Written by the user or from the user's words, not by an outside party. */
  readonly trusted: boolean;
  /** Epoch milliseconds. */
  readonly receivedAt: number;
  /** Sent to the task's conversation already. */
  readonly handled: boolean;
}

/**
 * One task: an ordinary conversation once the worker first takes it. Its
 * state is derived, not stored (ADR-0051 §2): `inboxTaskState` in
 * `@pinomad/client/inbox.ts`.
 */
export interface InboxTask {
  readonly id: string;
  readonly title: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Absent until the worker first takes it. */
  readonly conversationId?: ConversationId;
  /** Oldest first. */
  readonly events: readonly InboxEvent[];
  /** The worker sent a batch of its events and that run has not settled. */
  readonly inFlight?: true;
  /** Done, skipped or failed; a later event reopens it. */
  readonly closed: boolean;
  /** Closed by `skipInboxTask` rather than by a finished run. */
  readonly skipped?: true;
  /** Why the worker gave up on its last batch. */
  readonly failed?: string;
  /** Its run stopped on a question to the user. */
  readonly waiting?: true;
  /** The Inbox's own memory tidy-up (ADR-0052 §3). */
  readonly kind?: "tidy";
}

/** A timer not yet fired: a follow-up a task set for itself (`task`) or a schedule (`every`). */
export interface InboxFollowUp {
  readonly id: string;
  /** Epoch milliseconds of the next fire. */
  readonly due: number;
  readonly note: string;
  readonly task?: string;
  /** A schedule's period, in milliseconds. */
  readonly every?: number;
  /** The daily memory tidy-up; `cancelFollowUp` refuses it. */
  readonly kind?: "tidy";
}

/** One registered project's Inbox. Every project has one, empty until something arrives. */
export interface ProjectInbox {
  /** The project's path, as in the `index` stream. */
  readonly project: string;
  /** The project's intake conversation (ADR-0051 §6); absent until the user's first message. */
  readonly intake?: ConversationId;
  /** In arrival order. */
  readonly tasks: readonly InboxTask[];
  /** thread → task id. */
  readonly threads: Readonly<Record<string, string>>;
  /** The user's rules for this Inbox (`instructions.md`, ADR-0052 §1); empty when unset. */
  readonly rules: string;
  /** Timers not yet fired, soonest first. */
  readonly followUps: readonly InboxFollowUp[];
}

/** The `inbox` host stream (5.38): one entry per registered project, in the index's order. */
export interface HostInbox {
  readonly inboxes: readonly ProjectInbox[];
}

/** `setInboxRules` refuses rules longer than this many UTF-8 bytes. */
export const INBOX_RULES_MAX_BYTES = 16 * 1024;

/** Local minutes after midnight, `start` inclusive; may wrap past midnight. Equal ends mean none. */
export interface QuietHours {
  readonly start: number;
  readonly end: number;
}

/** Minutes in a day: a quiet-hours end is below this. */
export const MINUTES_PER_DAY = 1440;

export const isQuietHours = (value: unknown): value is QuietHours => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { start, end } = value as Record<string, unknown>;
  const minute = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < MINUTES_PER_DAY;
  return minute(start) && minute(end);
};
