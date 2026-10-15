// Push notifications (roadmap M5, ADR-0008 §9): a paired device registers its
// Expo push token over the secure channel; the host watches run statuses and
// posts one request per distinct token to the Expo Push Service. No Apple key
// on the host, no server of ours in between. The registry is a session document
// that is never streamed — the devices stream republishes the whole table to
// every client, and without Expo's enhanced push security a leaked token is a
// send capability.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { diffRunNotices, type RunNotice, type StatusBaseline } from "@pinomad/client/run-notifications.ts";
import { type HostIndex, organize } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { DevicesDoc } from "./devices.ts";
import type { HostValue } from "./host-value.ts";
import { IndexDoc } from "./organization.ts";
import { TitleDoc } from "./title-doc.ts";

const context: Context = BACKGROUND_CONTEXT;

/** One device's registered Expo push token; at most one per device public key. */
export type PushRegistration = {
  /** The paired device's base64url X25519 public key. */
  publicKey: string;
  token: string;
  updatedAt: number;
};

/** Shape of the session-scoped `pinomad.push` document. Mutable arrays: a Durable doc. */
export type PushRegistry = {
  registrations: PushRegistration[];
};

export const PushDoc = defineDoc<PushRegistry>({
  kind: "pinomad.push",
  version: 1,
  scope: "session",
  initial: () => ({ registrations: [] }),
});

// Expo issues ExponentPushToken[...] and, newer SDKs, ExpoPushToken[...].
const PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[^\]]+\]$/;
const PUSH_TOKEN_MAX_LENGTH = 256;

/** A problem string when `token` cannot be an Expo push token; `null` always passes (deregister). */
export function pushTokenProblem(token: string | null): string | undefined {
  if (token === null) return undefined;
  if (token.length > PUSH_TOKEN_MAX_LENGTH) {
    return `Push token is too long (${PUSH_TOKEN_MAX_LENGTH} characters at most)`;
  }
  if (!PUSH_TOKEN_PATTERN.test(token)) return "Not an Expo push token";
  return undefined;
}

/**
 * Register `token` under `publicKey` — the calling connection's own device —
 * or clear it when `token` is null. The device-table check shares the commit:
 * a device revoked between handshake and registration never acquires a token.
 */
export async function setPushToken(
  harness: Harness,
  publicKey: string,
  token: string | null,
  context: Context,
): Promise<void> {
  const problem = pushTokenProblem(token);
  if (problem !== undefined) throw new Error(problem);
  await harness.commit(async (tx) => {
    const devices = await tx.doc(DevicesDoc);
    if (!devices.devices.some((entry) => entry.publicKey === publicKey)) {
      throw new Error("Device is not paired");
    }
    const push = await tx.doc(PushDoc);
    push.registrations = push.registrations.filter((entry) => entry.publicKey !== publicKey);
    if (token !== null) push.registrations.push({ publicKey, token, updatedAt: Date.now() });
  }, context);
}

/**
 * Forget a paired device and its push registration in one commit — a revoked
 * device must never keep a send-capable token, not even for one commit.
 * Lives here because the transaction spans both documents.
 */
export async function revokeDevice(harness: Harness, publicKey: string, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const devices = await tx.doc(DevicesDoc);
    devices.devices = devices.devices.filter((entry) => entry.publicKey !== publicKey);
    const push = await tx.doc(PushDoc);
    push.registrations = push.registrations.filter((entry) => entry.publicKey !== publicKey);
  }, context);
}

/**
 * Drop every registration carrying `token`, but only when the registry still
 * holds exactly that token — a device that re-registered a fresh token since
 * the failed send must not lose it (Expo's DeviceNotRegistered is about the
 * old one).
 */
async function dropTokenIfCurrent(harness: Harness, token: string, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const push = await tx.doc(PushDoc);
    push.registrations = push.registrations.filter((entry) => entry.token !== token);
  }, context);
}

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** No titled conversation gets its first message leaked to Expo/Apple. */
const FALLBACK_TITLE = "PiNomad conversation";
const TITLE_WAIT_MS = 15_000;
const TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 10_000;
/** Initial send plus three exponential-backoff retries. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 5_000;
/** Expo recommends reading receipts ~15 minutes after the ticket. */
const RECEIPT_DELAY_MS = 15 * 60 * 1000;
/** Bounded in-memory outbox + pending receipt checks; nothing is persisted. */
const MAX_PENDING = 128;

/** The slice of fetch the sender needs — the real thing or a test double. */
export interface PushResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type PushFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<PushResponse>;

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
  /** The host's X25519 public key, base64url — the value clients store as StoredHost.hostKey. */
  readonly hostKey: string;
  readonly fetch?: PushFetch;
  readonly timers?: PushTimers;
}

type SendItem = {
  readonly token: string;
  readonly notice: RunNotice;
  /** The baseline generation the notice came from; any later status change makes the item stale. */
  readonly generation: number;
  /** Resolved on the first attempt; "Finished" items may wait for the auto-title. */
  title?: string;
  attempts: number;
  timer?: unknown;
};

/** What a ticket/recipient knows its token by: only the last few characters ever reach the log. */
const tokenHint = (token: string): string => `…${token.slice(-6)}`;

/**
 * Watch run statuses and notify registered devices. The baseline is seeded —
 * never announced — once the summaries and the index both delivered their
 * initial value, so a host restart does not re-send states that already stood.
 * Returns the detach; a detached sender's in-flight fetches settle but write
 * nothing back.
 */
export async function attachPushSender(options: PushSenderOptions): Promise<() => Promise<void>> {
  const { harness, conversations } = options;
  const fetcher = options.fetch ?? (fetch as PushFetch);
  const timers = options.timers ?? realTimers;

  const indexWatch = await harness.watchDoc(IndexDoc, context);
  let index: HostIndex | undefined = indexWatch?.value ?? undefined;
  let baseline: StatusBaseline | undefined;
  let disposed = false;

  const pending = new Set<SendItem>();
  const titleWaiters = new Map<ConversationId, Set<(title: string) => void>>();
  const receiptTimers = new Set<unknown>();
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

  const registrations = async (): Promise<ReadonlySet<string>> => {
    const doc = await harness.snapshot(PushDoc, context);
    return new Set((doc?.registrations ?? []).map((entry) => entry.token));
  };

  const post = async (url: string, payload: unknown): Promise<{ status: number; body: unknown }> => {
    const response = await fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A body read can still hit the request timeout or a dropped connection:
    // let it propagate so attempt treats it as the retryable failure it is.
    return { status: response.status, body: await response.json() };
  };

  /** Expo's per-message ticket; undefined or odd shapes count as a dead end — nothing to retry against. */
  const ticketOf = (body: unknown): { status?: string; id?: string; details?: { error?: string } } | undefined => {
    const data = (body as { data?: unknown } | undefined)?.data;
    const ticket = Array.isArray(data) ? data[0] : data;
    return ticket !== null && typeof ticket === "object"
      ? (ticket as { status?: string; id?: string; details?: { error?: string } })
      : undefined;
  };

  const message = (item: SendItem, title: string): Record<string, unknown> => ({
    to: item.token,
    title,
    body: item.notice.body,
    sound: "default",
    ttl: TTL_SECONDS,
    data: { hostKey: options.hostKey, conversationId: item.notice.id },
    // A conversation's newest state replaces its earlier banner and groups them.
    threadId: `${options.hostKey}:${item.notice.id}`,
    collapseId: `${options.hostKey}:${item.notice.id}`,
  });

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
  };

  const attempt = async (item: SendItem): Promise<void> => {
    if (disposed || !pending.has(item)) return;
    try {
      // Registration and conversation state are re-read before every attempt:
      // a revoked device or a status that moved on drops the notification.
      if (!(await registrations()).has(item.token) || !fresh(item)) return drop(item);
      if (item.title === undefined) {
        item.title = await titleFor(item.notice);
        // The queue-eviction drop ran while this item waited for a title.
        if (disposed || !pending.has(item) || !(await registrations()).has(item.token) || !fresh(item)) return drop(item);
      }
      const { status, body } = await post(EXPO_SEND_URL, message(item, item.title));
      const ticket = ticketOf(body);
      if (ticket?.details?.error === "DeviceNotRegistered") {
        drop(item);
        console.error(`push: token ${tokenHint(item.token)} is not registered (ticket)`);
        await dropTokenIfCurrent(harness, item.token, context);
        return;
      }
      if (status >= 200 && status < 300 && ticket?.status === "ok") {
        drop(item);
        if (typeof ticket.id === "string") scheduleReceiptCheck(item.token, ticket.id);
        return;
      }
      // 429 and 5xx retry like network failures; ticket errors and other 4xx are permanent.
      if ((status === 429 || status >= 500) && item.attempts + 1 < MAX_ATTEMPTS) {
        item.attempts += 1;
        item.timer = timers.setTimeout(() => void attempt(item), RETRY_BASE_MS * 2 ** (item.attempts - 1));
        return;
      }
      console.error(`push: send to ${tokenHint(item.token)} failed permanently (HTTP ${status})`);
      drop(item);
    } catch (error) {
      if (item.attempts + 1 < MAX_ATTEMPTS) {
        item.attempts += 1;
        item.timer = timers.setTimeout(() => void attempt(item), RETRY_BASE_MS * 2 ** (item.attempts - 1));
        return;
      }
      console.error(`push: send to ${tokenHint(item.token)} gave up: ${error instanceof Error ? error.message : String(error)}`);
      drop(item);
    }
  };

  const scheduleReceiptCheck = (token: string, ticketId: string): void => {
    const timer = timers.setTimeout(() => {
      receiptTimers.delete(timer);
      void checkReceipt(token, ticketId);
    }, RECEIPT_DELAY_MS);
    receiptTimers.add(timer);
    // Best effort and bounded: oldest pending checks are the first to go.
    while (receiptTimers.size > MAX_PENDING) {
      const oldest = receiptTimers.values().next().value!;
      receiptTimers.delete(oldest);
      timers.clearTimeout(oldest);
    }
  };

  const checkReceipt = async (token: string, ticketId: string): Promise<void> => {
    if (disposed) return;
    try {
      const { status, body } = await post(EXPO_RECEIPTS_URL, { ids: [ticketId] });
      const receipt =
        status >= 200 && status < 300
          ? ((body as { data?: Record<string, { status?: string; details?: { error?: string } }> } | undefined)?.data?.[
              ticketId
            ])
          : undefined;
      if (receipt === undefined || disposed) return;
      if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
        console.error(`push: token ${tokenHint(token)} is not registered (receipt)`);
        await dropTokenIfCurrent(harness, token, context);
        return;
      }
      if (receipt.status === "error") console.error(`push: receipt ${ticketId} reports ${receipt.details?.error ?? "error"}`);
    } catch (error) {
      console.error(`push: receipt check ${ticketId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const enqueue = async (notice: RunNotice): Promise<void> => {
    if (disposed) return;
    const itemGeneration = generation.get(notice.id) ?? 0;
    try {
      // One request per distinct token: devices sharing a token (reinstalls)
      // get one notification, and tokens from different EAS projects never mix
      // into a single Expo request.
      const tokens = await registrations();
      for (const token of tokens) {
        if (disposed) return;
        if (pending.size >= MAX_PENDING) {
          const [oldest] = pending;
          drop(oldest!);
        }
        const item: SendItem = { token, notice, generation: itemGeneration, attempts: 0 };
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

  return async () => {
    disposed = true;
    unsubscribeConversations();
    unsubscribeCommits();
    await indexWatch?.stop();
    for (const item of pending) drop(item);
    pending.clear();
    titleWaiters.clear();
    for (const timer of receiptTimers) timers.clearTimeout(timer);
    receiptTimers.clear();
  };
}
