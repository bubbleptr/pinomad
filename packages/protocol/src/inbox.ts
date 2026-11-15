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
  /** Timers not yet fired, soonest first. A schedule source's timer is not one: it shows as the source's `next`. */
  readonly followUps: readonly InboxFollowUp[];
  /** Where its events come from besides the user and the agent (5.39, ADR-0051 §10), oldest first. Absent before 5.39. */
  readonly sources?: readonly InboxSource[];
}

/** The `inbox` host stream (5.38): one entry per registered project, in the index's order. */
export interface HostInbox {
  readonly inboxes: readonly ProjectInbox[];
  /**
   * Whether this host takes plugin and webhook sources (5.39): only with an
   * OS sandbox for Inbox runs (ADR-0052 §7). Absent before 5.39.
   */
  readonly externalSources?: boolean;
}

/**
 * When a schedule source fires (5.39), in an IANA time zone (`Asia/Shanghai`).
 * `time` is `HH:MM`, 24-hour. `weekly`'s `day` is 0 (Sunday) to 6. `cron` is
 * five fields (minute hour day-of-month month day-of-week) of numbers, `*`,
 * ranges, lists and steps; day-of-week 7 is Sunday too.
 */
export type InboxSchedule =
  | { readonly kind: "daily"; readonly time: string; readonly timeZone: string }
  | { readonly kind: "weekdays"; readonly time: string; readonly timeZone: string }
  | { readonly kind: "weekly"; readonly day: number; readonly time: string; readonly timeZone: string }
  | { readonly kind: "cron"; readonly expression: string; readonly timeZone: string };

/**
 * What a source is (5.39). A schedule writes `note` into the Inbox each time
 * it fires, as a new task named after the source. A plugin source is one of
 * a loaded plugin's declared sources (`hello.plugins[].sources`), with the
 * user's `filter` in that source's own syntax. A webhook takes signed `POST`s
 * on the host's LAN and tailnet addresses.
 */
export type InboxSourceSpec =
  | { readonly kind: "schedule"; readonly schedule: InboxSchedule; readonly note: string }
  | { readonly kind: "plugin"; readonly plugin: string; readonly source: string; readonly filter: string }
  | { readonly kind: "webhook" };

/** One event source of an Inbox (5.39, ADR-0051 §10). */
export interface InboxSource {
  readonly id: string;
  /** The user's name for it, such as "Bugs on acme/web". */
  readonly name: string;
  readonly spec: InboxSourceSpec;
  /** Off: a schedule does not fire, a plugin source is not polled, a webhook answers 401. */
  readonly enabled: boolean;
  /**
   * Its events count as the user's own (the add-source dialog's "all tools")
   * rather than outside content ("restricted tools"): auto mode judges a run
   * with any untrusted event more strictly (ADR-0051 §7).
   */
  readonly trusted: boolean;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** A schedule's next fire, epoch milliseconds; absent while disabled. */
  readonly next?: number;
  /** Why the source could not deliver lately (a failed poll, a plugin that is not loaded); absent once it works. */
  readonly problem?: string;
}

/** A webhook source's address and signing secret: only `addInboxSource` and `resetInboxWebhookSecret` return them (5.39). */
export interface InboxWebhookAccess {
  /** `http://<LAN address>:<port>/inbox/<project>/events`; the loopback address when the host has no LAN listener. */
  readonly url: string;
  /** The source id, sent as the `X-Pinomad-Source` header. */
  readonly source: string;
  /** The HMAC-SHA256 key; the host never shows it again. */
  readonly secret: string;
}

/** A spec's shape, as `addInboxSource`'s arguments are checked; the host checks times, zones and cron fields. */
export const isInboxSourceSpec = (value: unknown): value is InboxSourceSpec => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  const text = (key: string, of: Record<string, unknown> = spec): boolean => typeof of[key] === "string";
  switch (spec.kind) {
    case "schedule": {
      const schedule = spec.schedule as Record<string, unknown> | null;
      if (typeof schedule !== "object" || schedule === null || Array.isArray(schedule) || !text("timeZone", schedule) || !text("note")) return false;
      switch (schedule.kind) {
        case "daily":
        case "weekdays":
          return text("time", schedule);
        case "weekly":
          return text("time", schedule) && typeof schedule.day === "number";
        case "cron":
          return text("expression", schedule);
        default:
          return false;
      }
    }
    case "plugin":
      return text("plugin") && text("source") && text("filter");
    case "webhook":
      return true;
    default:
      return false;
  }
};

/** `addInboxSource` refuses a name longer than this many characters, and a note longer than `INBOX_SOURCE_NOTE_MAX`. */
export const INBOX_SOURCE_NAME_MAX = 120;
export const INBOX_SOURCE_NOTE_MAX = 4_000;
export const INBOX_SOURCE_FILTER_MAX = 500;

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
