// Push notifications (ADR-0025): a paired device registers its APNs token over
// the secure channel; the host watches run statuses and asks the server —
// over the account control connection — to deliver one notification per
// distinct token. No Apple key on the host: signing lives on the server,
// which is why registrations require the host to be joined to an account.
// The registry is a session document that is never streamed — the devices
// stream republishes the whole table to every client, and a leaked token is a
// send capability.
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { diffRunNotices, type RunNotice, type StatusBaseline } from "@pinomad/client/run-notifications.ts";
import { type HostIndex, organize } from "@pinomad/protocol/organization.ts";
import type { ApnsEnvironment, PushNotification, PushVerdict } from "@pinomad/protocol/relay.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import type { PushToken } from "@pinomad/protocol/frames.ts";
import { DevicesDoc, RevocationsDoc } from "./devices.ts";
import type { HostValue } from "./host-value.ts";
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
}

/** The sender handle: close() detaches, stats() exposes the outbox counts (queued ⊆ pending). */
export interface PushSender {
  close(): Promise<void>;
  stats(): { pending: number; queued: number };
}

type SendItem = {
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly notice: RunNotice;
  /** The baseline generation the notice came from; any later status change makes the item stale. */
  readonly generation: number;
  /** Resolved on the first attempt; "Finished" items may wait for the auto-title. */
  title?: string;
  attempts: number;
  timer?: unknown;
  /** True while waiting for an in-flight slot — avoids double-queueing. */
  queued: boolean;
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
    baseline?.has(item.notice.id) === true && generation.get(item.notice.id) === item.generation;

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
  const titleFor = async (notice: RunNotice): Promise<string> => {
    const named = await namedTitle(notice.id);
    if (named !== undefined) return named;
    if (notice.body !== "Finished" || disposed) return FALLBACK_TITLE;
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

  const enqueue = async (notice: RunNotice): Promise<void> => {
    if (disposed) return;
    const itemGeneration = generation.get(notice.id) ?? 0;
    try {
      // One request per (environment, token) — the registration's identity,
      // the same key unregistration and eviction match on.
      const entries = await registrations();
      const seen = new Set<string>();
      for (const entry of entries) {
        if (disposed) return;
        const identity = `${entry.environment}:${entry.token}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (pending.size >= maxPending) {
          const [oldest] = pending;
          drop(oldest!);
        }
        const item: SendItem = { token: entry.token, environment: entry.environment, notice, generation: itemGeneration, attempts: 0, queued: false };
        pending.add(item);
        void attempt(item);
      }
    } catch (error) {
      console.error(`push: could not read registrations: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const unsubscribeConversations = conversations.subscribe(() => update());
  const unsubscribeCommits = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      // The publication carries the adopted title — resolving waiters needs no Session read.
      if (change.type !== "document" || change.record.kind !== TitleDoc.definition.kind) continue;
      const id = change.conversationId;
      if (id === undefined) continue;
      const title = (change.value as { title?: unknown } | null)?.title;
      if (typeof title !== "string" || title === "") continue;
      const waiters = titleWaiters.get(id);
      titleWaiters.delete(id);
      for (const settle of waiters ?? []) settle(title);
    }
  });
  indexWatch?.start(async (value) => {
    index = value ?? undefined;
    update();
  });
  update();

  return {
    stats: () => ({ pending: pending.size, queued: readyQueue.length }),
    async close() {
      disposed = true;
      unsubscribeConversations();
      unsubscribeCommits();
      await indexWatch?.stop();
      for (const item of pending) drop(item);
      pending.clear();
      readyQueue.length = 0;
      titleWaiters.clear();
    },
  };
}
