// Push notifications (ADR-0025): a paired device registers its APNs token over
// the secure channel; the host watches run statuses and asks the server —
// over the account control connection — to deliver one notification per
// distinct token. No Apple key on the host: signing lives on the server,
// which is why registrations require the host to be joined to an account.
// The registry is a session document that is never streamed — the devices
// stream republishes the whole table to every client, and a leaked token is a
// send capability.
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { diffRunNotices, type RunNotice, type StatusBaseline } from "@pinomad/client/run-notifications.ts";
import { type HostIndex, organize } from "@pinomad/protocol/organization.ts";
import type { ApnsEnvironment, PushNotification, PushVerdict } from "@pinomad/protocol/relay.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import type { PushToken } from "@pinomad/protocol/frames.ts";
import { DevicesDoc, RevocationsDoc } from "./devices.ts";
import type { HostValue } from "./host-value.ts";
import { inboxTaskOf, InboxDoc, OutboxDoc, type OutboxMessage, type OutboxPush as PushRecord } from "./inbox.ts";
import { DEFAULT_POLICY, type DeliveryPolicy, failedDelivery, plan } from "./outbox-policy.ts";
import { IndexDoc } from "./organization.ts";
import { TitleDoc } from "./title-doc.ts";

const context: Context = BACKGROUND_CONTEXT;

/** One device's registered APNs token; at most one registration per device public key. */
export type PushRegistration = {
  /** The paired device's base64url X25519 public key. */
  publicKey: string;
  /** The APNs device token, hex — Apple does not fix its length. */
  token: string;
  environment: ApnsEnvironment;
  updatedAt: number;
};

/** Shape of the session-scoped `pinomad.push` document. Mutable arrays: a Durable doc. */
export type PushRegistry = {
  registrations: PushRegistration[];
};

export const PushDoc = defineDoc<PushRegistry>({
  kind: "pinomad.push",
  // v1 registrations were Expo token strings, dead on arrival here — the app
  // re-registers its APNs token on connect, so the migration just clears.
  version: 2,
  scope: "session",
  initial: () => ({ registrations: [] }),
  migrate: () => ({ registrations: [] }),
  checkpointWhen: () => false,
});

// Apple does not fix token lengths; today's are 32 bytes (64 hex). 256 hex
// chars leaves a wide margin while still bounding what lands in the registry.
const APNS_TOKEN_PATTERN = /^(?:[0-9a-f]{2})+$/;
const APNS_TOKEN_MAX_CHARS = 256;

const isApnsEnvironment = (value: unknown): value is ApnsEnvironment =>
  value === "production" || value === "development";

/**
 * A problem string when `token` cannot be registered; `null` always passes
 * (deregister). A legacy Expo token string parses fine at the frame level but
 * is refused here — Expo push is retired (ADR-0025 §7).
 */
export function pushTokenProblem(token: PushToken | null): string | undefined {
  if (token === null) return undefined;
  if (typeof token === "string") {
    return "Push notifications no longer go through Expo — register the device's APNs token instead";
  }
  if (!isApnsEnvironment(token.environment)) {
    return 'environment must be "production" or "development"';
  }
  const apns = token.apns.toLowerCase();
  if (apns.length > APNS_TOKEN_MAX_CHARS) {
    return `APNs token is too long (${APNS_TOKEN_MAX_CHARS} characters at most)`;
  }
  if (!APNS_TOKEN_PATTERN.test(apns)) return "Not an APNs device token (expected hex)";
  return undefined;
}

/**
 * Register `token` under `publicKey` — the calling connection's own device —
 * or clear it when `token` is null. `joined` answers whether this host is
 * bound to an account: pushes ride the account control connection, so a host
 * that never joined can register nothing. The device-table check shares the
 * commit: a device revoked between handshake and registration never acquires
 * a token.
 */
export async function setPushToken(
  harness: Harness,
  publicKey: string,
  token: PushToken | null,
  context: Context,
  joined: () => Promise<boolean>,
): Promise<void> {
  const problem = pushTokenProblem(token);
  if (problem !== undefined) throw new Error(problem);
  if (token !== null && typeof token !== "string" && !(await joined())) {
    throw new Error("Push notifications need the host joined to an account (`pinomad join`)");
  }
  await harness.commit(async (tx) => {
    const devices = await tx.doc(DevicesDoc);
    if (!devices.devices.some((entry) => entry.publicKey === publicKey)) {
      throw new Error("Device is not paired");
    }
    const push = await tx.doc(PushDoc);
    push.registrations = push.registrations.filter((entry) => entry.publicKey !== publicKey);
    if (token !== null && typeof token !== "string") {
      push.registrations.push({
        publicKey,
        token: token.apns.toLowerCase(),
        environment: token.environment,
        updatedAt: Date.now(),
      });
    }
  }, context);
}

/**
 * Forget a paired device, its push registration, and record the revocation in
 * one commit — a revoked device must never keep a send-capable token, not even
 * for one commit, and an account offer must never re-register a revoked key
 * (ADR-0022 §6). Lives here because the transaction spans three documents.
 */
export async function revokeDevice(harness: Harness, publicKey: string, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const devices = await tx.doc(DevicesDoc);
    devices.devices = devices.devices.filter((entry) => entry.publicKey !== publicKey);
    const push = await tx.doc(PushDoc);
    push.registrations = push.registrations.filter((entry) => entry.publicKey !== publicKey);
    const revocations = await tx.doc(RevocationsDoc);
    if (!revocations.revoked.includes(publicKey)) revocations.revoked.push(publicKey);
  }, context);
}

/**
 * Drop the (token, environment) registration APNs invalidated — only when the
 * registry still holds exactly that pair written before the invalidation
 * time. A device that re-registered since must not lose its fresh token to a
 * late 410 (ADR-0025 §5).
 */
async function dropStaleRegistration(
  harness: Harness,
  token: string,
  environment: ApnsEnvironment,
  unregisteredAt: number,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const push = await tx.doc(PushDoc);
    push.registrations = push.registrations.filter(
      (entry) =>
        entry.token !== token || entry.environment !== environment || entry.updatedAt >= unregisteredAt,
    );
  }, context);
}

/** No titled conversation gets its first message leaked to the server/Apple. */
const FALLBACK_TITLE = "PiNomad conversation";
const TITLE_WAIT_MS = 15_000;
/** A banner's title must fit the bounded frame field and stay far under APNs' 4 KiB payload. */
const TITLE_MAX_CHARS = 160;
/** Initial send plus three retries; the delay comes from the verdict or the backoff. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 5_000;
/** Pushes in flight to the server at once; excess waits in line. */
const MAX_INFLIGHT = 8;
/** Bounded in-memory outbox; nothing is persisted. */
const MAX_PENDING = 128;
/** What a `notify` push says; the agent's text stays on the host (ADR-0025 §8). */
export const NOTIFY_BODY = "Update for you";
/** A digest's title: it speaks for several tasks, so no one conversation's title fits. */
const DIGEST_TITLE = "PiNomad Inbox";

/**
 * The send seam the relay link implements and tests fake: one notification to
 * one token, resolved to its classified verdict. Implementations never
 * reject — connection loss and timeouts arrive as `retry` verdicts.
 */
export interface PushTransport {
  send(request: {
    readonly token: string;
    readonly environment: ApnsEnvironment;
    readonly notification: PushNotification;
  }): Promise<PushVerdict>;
}

const UNAVAILABLE_TRANSPORT: PushTransport = {
  send: () => Promise.resolve({ result: "unavailable", reason: "no server connection" }),
};

/** Timer seam so tests drive retries and title waits with a manual clock. */
export interface PushTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: PushTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PushSenderOptions {
  readonly harness: Harness;
  /** The gateway's conversation summaries — the source `diffRunNotices` diffs. */
  readonly conversations: HostValue<readonly ConversationSummary[]>;
  /** The host's X25519 public key, base64url — the push payload's `data.hostKey`. */
  readonly hostKey: string;
  /** The control-connection transport; absent → every send answers `unavailable`. */
  readonly transport?: PushTransport;
  readonly timers?: PushTimers;
  /** Outbox bounds — the constants above; tests pass small ones. */
  readonly limits?: { readonly maxPending?: number; readonly maxInflight?: number };
  /** The pacing of `notify` pushes (ADR-0052 §4), read on each look; DEFAULT_POLICY when absent. */
  readonly outboxPolicy?: () => DeliveryPolicy;
  /** Calls back when the policy may have changed (the quiet hours setting): held messages are planned again. */
  readonly onOutboxPolicyChange?: (listener: () => void) => () => void;
  /** The time the pacing reads; tests pair it with their manual timers. */
  readonly now?: () => number;
}

/** The sender handle: close() detaches, stats() exposes the outbox counts (queued ⊆ pending). */
export interface PushSender {
  close(): Promise<void>;
  stats(): { pending: number; queued: number };
}

/**
 * A run notice, or a `notify` push: the latter has no status to go stale
 * against. A digest of several carries its own fixed title.
 */
type Notice = {
  readonly id: ConversationId;
  readonly body: string;
  /** Not `title`: a RunNotice's `title` is the summary's display name, which may be the first message. */
  readonly fixedTitle?: string;
  readonly notify?: true;
};

type SendItem = {
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly notice: Notice;
  /** The baseline generation the notice came from; any later status change makes the item stale. */
  readonly generation: number;
  /** Resolved on the first attempt; "Finished" items may wait for the auto-title. */
  title?: string;
  attempts: number;
  timer?: unknown;
  /** True while waiting for an in-flight slot — avoids double-queueing. */
  queued: boolean;
  /** The outbox push this delivers: its messages are settled once its last item settles. */
  readonly outbox?: string;
  /** APNs accepted it. */
  accepted?: boolean;
  /** Retried until it gave up: the push may go out again later. */
  gaveUp?: boolean;
};

/** What a log knows a token by: only the last few characters ever reach it. */
const tokenHint = (token: string): string => `…${token.slice(-6)}`;

/**
 * `apns-collapse-id` is capped at 64 bytes and `hostKey:conversationId` can
 * exceed it — a fixed-length digest keeps the grouping property without the
 * length risk (ADR-0025 §2).
 */
const collapseId = (hostKey: string, id: ConversationId): string =>
  createHash("sha256").update(`${hostKey}:${id}`).digest("hex").slice(0, 32);

/**
 * Watch run statuses and notify registered devices. The baseline is seeded —
 * never announced — once the summaries and the index both delivered their
 * initial value, so a host restart does not re-send states that already stood.
 * A closed sender's in-flight requests settle but write nothing back.
 */
export async function attachPushSender(options: PushSenderOptions): Promise<PushSender> {
  const { harness, conversations } = options;
  const transport = options.transport ?? UNAVAILABLE_TRANSPORT;
  const timers = options.timers ?? realTimers;
  const maxPending = options.limits?.maxPending ?? MAX_PENDING;
  const maxInflight = options.limits?.maxInflight ?? MAX_INFLIGHT;

  const indexWatch = await harness.watchDoc(IndexDoc, context);
  let index: HostIndex | undefined = indexWatch?.value ?? undefined;
  let baseline: StatusBaseline | undefined;
  let disposed = false;

  const pending = new Set<SendItem>();
  const titleWaiters = new Map<ConversationId, Set<(title: string) => void>>();
  let inflight = 0;
  const readyQueue: SendItem[] = [];
  let unavailableLogged = false;
  /**
   * Per-conversation transition counter: comparing statuses alone cannot tell
   * apart "unchanged" and "left and came back" (needs-answer → running →
   * needs-answer), so every diff bump marks earlier notifications stale.
   */
  const generation = new Map<ConversationId, number>();

  const update = (): void => {
    if (index === undefined) return;
    const organized = organize(index, conversations.value);
    if (baseline === undefined) {
      baseline = diffRunNotices(undefined, organized).baseline;
      for (const id of baseline.keys()) generation.set(id, 0);
      return;
    }
    const diff = diffRunNotices(baseline, organized);
    baseline = diff.baseline;
    for (const id of diff.changed) generation.set(id, (generation.get(id) ?? 0) + 1);
    for (const notice of diff.notices) void enqueue(notice);
  };

  /** The transition the notice reported must still be the latest for a send to go out. */
  const fresh = (item: SendItem): boolean =>
    item.notice.notify === true ||
    (baseline?.has(item.notice.id) === true && generation.get(item.notice.id) === item.generation);

  const registrations = async (): Promise<readonly PushRegistration[]> => {
    const doc = await harness.snapshot(PushDoc, context);
    return doc?.registrations ?? [];
  };

  const findRegistration = (entries: readonly PushRegistration[], item: SendItem): PushRegistration | undefined =>
    entries.find((entry) => entry.token === item.token && entry.environment === item.environment);

  const namedTitle = async (id: ConversationId): Promise<string | undefined> => {
    const doc = await harness.snapshot(TitleDoc, id, context);
    return typeof doc?.title === "string" && doc.title !== "" ? doc.title : undefined;
  };

  /**
   * The title a push may carry: only the formal `pinomad.title` name — the
   * summary's fallback is the user's first message verbatim, which must never
   * leave the host. "Finished" waits for the auto-title write; everything else
   * takes the fallback at once.
   */
  const titleFor = async (notice: Notice): Promise<string> => {
    if (notice.fixedTitle !== undefined) return notice.fixedTitle;
    const named = await namedTitle(notice.id);
    if (named !== undefined) return named;
    if ((notice.body !== "Finished" && notice.notify !== true) || disposed) return FALLBACK_TITLE;
    return await new Promise<string>((resolve) => {
      const waiters = titleWaiters.get(notice.id) ?? new Set<(title: string) => void>();
      titleWaiters.set(notice.id, waiters);
      const settle = (title: string): void => {
        waiters.delete(settle);
        if (waiters.size === 0) titleWaiters.delete(notice.id);
        timers.clearTimeout(timer);
        resolve(title);
      };
      const timer = timers.setTimeout(() => settle(FALLBACK_TITLE), TITLE_WAIT_MS);
      waiters.add(settle);
      // The waiter registered before this read, so a commit between the first
      // snapshot and now is covered by one of the two.
      void namedTitle(notice.id).then((title) => {
        if (title !== undefined) settle(title);
      });
    });
  };

  const drop = (item: SendItem): void => {
    pending.delete(item);
    if (item.timer !== undefined) timers.clearTimeout(item.timer);
    // Also leave the ready queue: an item evicted while queued would keep its
    // reference there forever, and the outbox bound is on both structures.
    const queuedAt = readyQueue.indexOf(item);
    if (queuedAt >= 0) readyQueue.splice(queuedAt, 1);
    // A sender closing mid-send leaves the message unsent: the next start pushes it.
    if (item.outbox !== undefined && !disposed) {
      const push = outboxPushes.get(item.outbox);
      if (push !== undefined) {
        push.left -= 1;
        if (item.accepted === true) push.accepted = true;
        if (item.gaveUp === true) push.gaveUp = true;
        if (push.left <= 0) {
          outboxPushes.delete(item.outbox);
          void settlePush(item.outbox, push);
        }
      }
    }
  };

  /** Releases one queued item per freed in-flight slot. */
  const pump = (): void => {
    while (inflight < maxInflight) {
      const next = readyQueue.shift();
      if (next === undefined) return;
      next.queued = false;
      void attempt(next);
    }
  };

  const scheduleRetry = (item: SendItem, retryAfterMs?: number): void => {
    if (item.attempts + 1 >= MAX_ATTEMPTS) {
      console.error(`push: send to ${tokenHint(item.token)} gave up`);
      item.gaveUp = true;
      drop(item);
      return;
    }
    // A server-directed delay (5xx ≥ 15 min) wins over the local 5/10/20 s
    // backoff (ADR-0025 §5).
    const delayMs = retryAfterMs ?? RETRY_BASE_MS * 2 ** item.attempts;
    item.attempts += 1;
    item.timer = timers.setTimeout(() => void attempt(item), delayMs);
  };

  const attempt = async (item: SendItem): Promise<void> => {
    if (disposed || !pending.has(item)) return;
    try {
      // Registration and conversation state are re-read before every attempt:
      // a revoked device or a status that moved on drops the notification.
      if (findRegistration(await registrations(), item) === undefined || !fresh(item)) return drop(item);
      if (item.title === undefined) {
        item.title = await titleFor(item.notice);
        // The queue-eviction drop ran while this item waited for a title.
        if (
          disposed ||
          !pending.has(item) ||
          findRegistration(await registrations(), item) === undefined ||
          !fresh(item)
        ) {
          return drop(item);
        }
      }
      if (inflight >= maxInflight) {
        if (!item.queued) {
          item.queued = true;
          readyQueue.push(item);
        }
        return;
      }
      inflight += 1;
      let verdict: PushVerdict;
      try {
        verdict = await transport.send({
          token: item.token,
          environment: item.environment,
          notification: {
            title: item.title.slice(0, TITLE_MAX_CHARS),
            body: item.notice.body,
            collapseId: collapseId(options.hostKey, item.notice.id),
            hostKey: options.hostKey,
            conversationId: item.notice.id,
          },
        });
      } catch {
        verdict = { result: "retry", reason: "transport error" };
      } finally {
        inflight -= 1;
        pump();
      }
      if (disposed || !pending.has(item)) return drop(item);
      switch (verdict.result) {
        case "accepted":
          item.accepted = true;
          drop(item);
          return;
        case "unregistered":
          drop(item);
          await dropStaleRegistration(harness, item.token, item.environment, verdict.unregisteredAt, context);
          return;
        case "retry":
          scheduleRetry(item, verdict.retryAfterMs);
          return;
        case "rejected":
          // No delete, no retry: BadDeviceToken can mean a misconfigured
          // environment — the app re-registers on its next connect (ADR-0025 §5).
          console.error(`push: send to ${tokenHint(item.token)} rejected: ${verdict.reason}`);
          drop(item);
          return;
        case "unavailable":
          // A server that can't deliver (no declaration, no such environment)
          // is a standing condition — log it once per sender, not per banner.
          if (!unavailableLogged) {
            unavailableLogged = true;
            console.error(`push: ${verdict.reason} — notifications are not being delivered`);
          }
          drop(item);
          return;
      }
    } catch (error) {
      console.error(`push: send to ${tokenHint(item.token)} failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRetry(item);
    }
  };

  /** An Inbox run ends quietly unless it called `notify` (ADR-0051 §9). */
  const inboxRun = async (id: ConversationId): Promise<boolean> => {
    const [inboxes, current] = await Promise.all([harness.snapshot(InboxDoc, context), harness.snapshot(IndexDoc, context)]);
    return inboxes !== undefined && current !== undefined && inboxTaskOf(inboxes.inboxes, current, id) !== undefined;
  };

  /** Pushes created for `notice`; an outbox push's are counted before any can settle. */
  const enqueue = async (notice: Notice, outbox?: string): Promise<number> => {
    let created = 0;
    if (disposed) return created;
    const itemGeneration = generation.get(notice.id) ?? 0;
    try {
      if (notice.body === "Finished" && (await inboxRun(notice.id))) return created;
      // A run notice keeps only what a push may carry: its id and body.
      if (notice.notify !== true) notice = { id: notice.id, body: notice.body };
      // One request per (environment, token) — the registration's identity,
      // the same key unregistration and eviction match on.
      const entries = await registrations();
      const seen = new Set<string>();
      for (const entry of entries) {
        if (disposed) return created;
        const identity = `${entry.environment}:${entry.token}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (pending.size >= maxPending) {
          const [oldest] = pending;
          drop(oldest!);
        }
        const item: SendItem = {
          token: entry.token,
          environment: entry.environment,
          notice,
          generation: itemGeneration,
          attempts: 0,
          queued: false,
          ...(outbox === undefined ? {} : { outbox }),
        };
        if (outbox !== undefined) outboxPushes.get(outbox)!.left += 1;
        created += 1;
        pending.add(item);
        void attempt(item);
      }
    } catch (error) {
      console.error(`push: could not read registrations: ${error instanceof Error ? error.message : String(error)}`);
    }
    return created;
  };

  /**
   * `notify` messages, paced by the policy (ADR-0052 §4): what is ready goes
   * out as one push, or a digest of several. Their messages are marked sent
   * once every push item settled, or scheduled again when none reached a
   * device; a host stopped before that sends them again on start.
   */
  const now = options.now ?? Date.now;
  const policy = options.outboxPolicy ?? (() => DEFAULT_POLICY);
  const taken = new Set<string>();
  type OutboxPush = { readonly ids: readonly string[]; left: number; accepted: boolean; gaveUp: boolean };
  const outboxPushes = new Map<string, OutboxPush>();
  let latest: { readonly messages: readonly Readonly<OutboxMessage>[]; readonly pushes: readonly Readonly<PushRecord>[] } = { messages: [], pushes: [] };
  let wake: unknown;

  const writeOutbox = (change: (message: OutboxMessage) => void, ids: ReadonlySet<string>): Promise<void> =>
    harness
      .commit(async (tx) => {
        for (const message of (await tx.doc(OutboxDoc)).messages) if (ids.has(message.id)) change(message);
      }, context)
      .catch((error: unknown) => {
        if (!disposed) console.error(`push: could not update notify messages: ${error instanceof Error ? error.message : String(error)}`);
      });

  async function settlePush(pushId: string, push: OutboxPush): Promise<void> {
    const ids = new Set(push.ids);
    const at = now();
    if (push.gaveUp && !push.accepted) {
      await writeOutbox((message) => {
        const next = failedDelivery(message, at);
        message.attempts = next.attempts;
        if ("giveUp" in next) {
          message.sent = true;
          message.failed = true;
          delete message.retryAt;
        } else message.retryAt = next.retryAt;
      }, ids);
    } else {
      await writeOutbox((message) => {
        message.sent = true;
        message.sentAt = at;
        message.pushId = pushId;
        delete message.retryAt;
      }, ids);
    }
    for (const id of push.ids) taken.delete(id);
  }

  const deliver = async (outbox: typeof latest): Promise<void> => {
    if (disposed) return;
    const decision = plan(
      outbox.messages.filter((message) => !taken.has(message.id)),
      outbox.pushes,
      now(),
      policy(),
    );
    if (wake !== undefined) timers.clearTimeout(wake);
    wake = undefined;
    if (decision.wakeAt !== undefined) {
      wake = timers.setTimeout(() => onOutbox(latest), Math.max(decision.wakeAt - now(), 0));
    }
    if (decision.drop.length > 0) await writeOutbox((message) => void (message.sent = true), new Set(decision.drop));
    if (decision.send.length === 0) return;
    const group = decision.send;
    for (const message of group) taken.add(message.id);
    const pushId = `push:${group[0]!.id}`;
    outboxPushes.set(pushId, { ids: group.map((message) => message.id), left: 0, accepted: false, gaveUp: false });
    const last = group.at(-1)!;
    const notice: Notice =
      group.length === 1
        ? { id: last.conversationId, body: NOTIFY_BODY, notify: true }
        : { id: last.conversationId, body: `${group.length} updates for you`, fixedTitle: DIGEST_TITLE, notify: true };
    const created = await enqueue(notice, pushId);
    if (created === 0) {
      // No device to push to: done with these messages, and nothing went out to count.
      outboxPushes.delete(pushId);
      await writeOutbox((message) => void (message.sent = true), new Set(group.map((message) => message.id)));
      for (const message of group) taken.delete(message.id);
      return;
    }
    // Counted the moment it goes out, not when its slowest device settles: the cap
    // holds while one device still retries, and outlives the trimmed message history.
    const at = now();
    await harness
      .commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc);
        doc.pushes = [...(doc.pushes ?? []).filter((push) => at - push.at < 60 * 60_000), { id: pushId, at }];
      }, context)
      .catch((error: unknown) => {
        if (!disposed) console.error(`push: could not record a notify push: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  let delivering = Promise.resolve();
  // A watch needs the document to exist; the first notify would otherwise go unseen.
  await harness.commit(async (tx) => {
    await tx.doc(OutboxDoc);
  }, context);
  const outboxWatch = await harness.watchDoc(OutboxDoc, context);
  function onOutbox(outbox: typeof latest): void {
    latest = outbox;
    delivering = delivering
      .then(() => deliver(outbox))
      .catch((error: unknown) => {
        if (!disposed) console.error(`push: could not deliver notify messages: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  const unsubscribeConversations = conversations.subscribe(() => update());
  const commits = harness.observeCommits({
    advance: (publication) => {
      for (const change of publication.changes) {
        // The publication carries the adopted title — resolving waiters needs no Session read.
        if (change.type !== "document" || change.kind !== "change" || change.record.kind !== TitleDoc.definition.kind) continue;
        const id = change.conversationId;
        if (id === undefined) continue;
        const title = (change.value as { title?: unknown }).title;
        if (typeof title !== "string" || title === "") continue;
        const waiters = titleWaiters.get(id);
        titleWaiters.delete(id);
        for (const settle of waiters ?? []) settle(title);
      }
    },
    end: () => {},
  });
  indexWatch?.start(async (call) => {
    if (call.kind !== "value") return;
    // The session index is never retired.
    index = call.value;
    update();
  });
  update();
  if (outboxWatch === undefined) throw new Error("Outbox document is not available");
  onOutbox({ messages: outboxWatch.value?.messages ?? [], pushes: outboxWatch.value?.pushes ?? [] });
  outboxWatch.start(async (call) => {
    if (call.kind === "value") onOutbox({ messages: call.value?.messages ?? [], pushes: call.value?.pushes ?? [] });
  });
  // A held message's wake time came from the old policy: shortened quiet hours must not wait it out.
  const unsubscribePolicy = options.onOutboxPolicyChange?.(() => onOutbox(latest));

  return {
    stats: () => ({ pending: pending.size, queued: readyQueue.length }),
    async close() {
      disposed = true;
      unsubscribeConversations();
      unsubscribePolicy?.();
      commits.detach();
      await indexWatch?.stop();
      if (wake !== undefined) timers.clearTimeout(wake);
      await outboxWatch.stop();
      await delivering;
      for (const item of pending) drop(item);
      pending.clear();
      readyQueue.length = 0;
      titleWaiters.clear();
    },
  };
}
