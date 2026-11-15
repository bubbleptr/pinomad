// Inbox event sources (ADR-0051 §10): schedules, plugin sources and LAN
// webhooks, each added to one project's Inbox. A schedule is a timer on the
// Inbox's timer document; a plugin source is polled (or listens) in the host
// process; a webhook takes HMAC-signed POSTs on the gateway's LAN and tailnet
// addresses, never through the relay (ADR-0008, ADR-0022). Every event goes
// into the Inbox the way `addInboxEvent` puts one, with the source's id in
// front of its own so no source can take another's (or the host's) event ids.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import {
  INBOX_SOURCE_FILTER_MAX,
  INBOX_SOURCE_NAME_MAX,
  INBOX_SOURCE_NOTE_MAX,
  type InboxSourceSpec,
  type InboxWebhookAccess,
} from "@pinomad/protocol/inbox.ts";
import type { SourceEvent } from "@pinomad/plugin/v1";
import { InboxDoc, projectKey, recordSourceEvent, TimerDoc } from "./inbox.ts";
import { inboxName } from "./inbox-memory.ts";
import { IndexDoc } from "./organization.ts";
import type { LoadedSource, PluginCatalog } from "./plugins.ts";
import { SOURCE_EVENT_LIMITS } from "./plugins.ts";
import { checkSchedule, nextFire } from "./schedule.ts";
import type { SecretStore } from "./secrets.ts";

export type InboxSourceRecord = {
  id: string;
  /** The Inbox's project key. */
  project: string;
  name: string;
  spec: InboxSourceSpec;
  enabled: boolean;
  trusted: boolean;
  createdAt: number;
  /** Why it could not deliver lately; cleared once it does. */
  problem?: string;
};

export const SourcesDoc = defineDoc<{ sources: InboxSourceRecord[] }>({
  kind: "pinomad.inbox-sources",
  version: 1,
  scope: "session",
  initial: () => ({ sources: [] }),
  checkpointWhen: () => false,
});

/**
 * Each polled source's cursor, by source id. A document of its own: a poll
 * that brings nothing still moves its cursor, and the `inbox` stream and the
 * workers watch the other documents.
 */
export const SourceCursorsDoc = defineDoc<{ cursors: Record<string, JsonValue> }>({
  kind: "pinomad.inbox-source-cursors",
  version: 1,
  scope: "session",
  initial: () => ({ cursors: {} }),
  checkpointWhen: () => false,
});

/**
 * Where webhook secrets live in the host's credential store, next to the
 * plugins' secrets: no plugin can have this name (`^[a-z][a-z0-9-]*$`).
 */
export const WEBHOOK_SECRETS = "@inbox-webhooks";

/** A webhook request's body may be at most this many bytes, and its timestamp this far from the host's clock. */
export const WEBHOOK_MAX_BYTES = 64 * 1024;
export const WEBHOOK_WINDOW_MS = 5 * 60_000;

const timerId = (sourceId: string): string => `source:${sourceId}`;

/** What the service needs besides the document store. */
export interface SourceDeps {
  readonly harness: Harness;
  readonly secrets: SecretStore;
  /** The loaded plugins; absent when they failed to load. */
  readonly plugins: () => PluginCatalog | undefined;
  /** Whether Inbox runs get an OS sandbox: without one, plugin and webhook sources are refused (ADR-0052 §7). */
  readonly sandboxAvailable: () => Promise<boolean>;
  /** The gateway's base for webhook URLs (`http://<LAN address>:<port>`); undefined until it listens. */
  readonly webhookBase: () => string | undefined;
}

export const isExternal = (spec: InboxSourceSpec): boolean => spec.kind !== "schedule";

const NO_SANDBOX = "This host has no sandbox for Inbox runs, so it takes no plugin or webhook sources (install bubblewrap on Linux)";

/** A webhook source's URL path for `project`. */
export const webhookPath = (project: string): string => `/inbox/${encodeURIComponent(inboxName(project))}/events`;

function webhookAccess(deps: SourceDeps, record: InboxSourceRecord, secret: string): InboxWebhookAccess {
  return { url: `${deps.webhookBase() ?? "http://127.0.0.1"}${webhookPath(record.project)}`, source: record.id, secret };
}

const newSecret = (): string => randomBytes(32).toString("base64url");

/** Checks what a client asked for; throws the reason it is refused. */
async function checkSpec(deps: SourceDeps, input: { name: string; spec: InboxSourceSpec }): Promise<void> {
  if (input.name.trim().length === 0 || input.name.length > INBOX_SOURCE_NAME_MAX) {
    throw new Error(`A source's name is 1 to ${INBOX_SOURCE_NAME_MAX} characters`);
  }
  const { spec } = input;
  if (isExternal(spec) && !(await deps.sandboxAvailable())) throw new Error(NO_SANDBOX);
  switch (spec.kind) {
    case "schedule":
      if (spec.note.trim().length === 0 || spec.note.length > INBOX_SOURCE_NOTE_MAX) {
        throw new Error(`A schedule's note is 1 to ${INBOX_SOURCE_NOTE_MAX} characters`);
      }
      checkSchedule(spec.schedule);
      return;
    case "plugin": {
      if (spec.filter.length > INBOX_SOURCE_FILTER_MAX) throw new Error(`A filter is at most ${INBOX_SOURCE_FILTER_MAX} characters`);
      const plugins = deps.plugins();
      if (plugins?.info.some((each) => each.name === spec.plugin) !== true) throw new Error(`Plugin ${spec.plugin} is not loaded`);
      if (plugins.source(spec.plugin, spec.source) === undefined) throw new Error(`Plugin ${spec.plugin} has no source ${spec.source}`);
      return;
    }
    case "webhook":
      return;
  }
}

/** The source by id, writable, or a refusal. */
async function sourceIn(tx: Tx, sourceId: string): Promise<{ list: InboxSourceRecord[]; record: InboxSourceRecord }> {
  const list = (await tx.doc(SourcesDoc)).sources;
  const record = list.find((each) => each.id === sourceId);
  if (record === undefined) throw new Error(`No source ${sourceId}`);
  return { list, record };
}

/** Turn a schedule source's timer on (from now) or off. */
async function scheduleTimer(tx: Tx, record: InboxSourceRecord, on: boolean): Promise<void> {
  if (record.spec.kind !== "schedule") return;
  const timers = (await tx.doc(TimerDoc)).timers;
  const id = timerId(record.id);
  const due = on ? nextFire(record.spec.schedule, Date.now()) : undefined;
  const timer = timers.find((each) => each.id === id);
  if (timer === undefined) {
    const { note, schedule } = record.spec;
    timers.push({ id, project: record.project, due: due ?? 0, note, done: !on, source: record.id, schedule, title: record.name, trusted: record.trusted });
    return;
  }
  timer.done = !on;
  if (due !== undefined) timer.due = due;
}

export async function addInboxSource(
  deps: SourceDeps,
  input: { project: string; name: string; trusted: boolean; spec: InboxSourceSpec },
  context: Context,
): Promise<{ sourceId: string; webhook?: InboxWebhookAccess }> {
  await checkSpec(deps, input);
  const key = await projectKey(input.project);
  const record: InboxSourceRecord = {
    id: randomUUID(),
    project: key,
    name: input.name.trim(),
    spec: input.spec,
    enabled: true,
    trusted: input.trusted,
    createdAt: Date.now(),
  };
  // The secret is stored before the source exists, so a webhook never answers without one; a refused commit takes it back.
  const secret = record.spec.kind === "webhook" ? newSecret() : undefined;
  if (secret !== undefined) await deps.secrets.set(WEBHOOK_SECRETS, record.id, secret);
  try {
    await deps.harness.commit(async (tx) => {
      if (!(await tx.doc(IndexDoc)).projects.some((each) => each.path === key)) throw new Error(`Unknown project: ${input.project}`);
      (await tx.doc(SourcesDoc)).sources.push(record);
      await scheduleTimer(tx, record, true);
    }, context);
  } catch (error) {
    if (secret !== undefined) await deps.secrets.set(WEBHOOK_SECRETS, record.id, null);
    throw error;
  }
  return { sourceId: record.id, ...(secret === undefined ? {} : { webhook: webhookAccess(deps, record, secret) }) };
}

export async function setInboxSourceEnabled(deps: SourceDeps, sourceId: string, enabled: boolean, context: Context): Promise<void> {
  const record = (await deps.harness.snapshot(SourcesDoc, context))?.sources.find((each) => each.id === sourceId);
  // Turning an outside source on is adding it again: the same sandbox rule.
  if (enabled && record !== undefined && isExternal(record.spec) && !(await deps.sandboxAvailable())) throw new Error(NO_SANDBOX);
  await deps.harness.commit(async (tx) => {
    const { record } = await sourceIn(tx, sourceId);
    if (record.enabled === enabled) return;
    record.enabled = enabled;
    await scheduleTimer(tx, record, enabled);
  }, context);
}

export async function removeInboxSource(deps: SourceDeps, sourceId: string, context: Context): Promise<void> {
  await deps.harness.commit(async (tx) => {
    const { list, record } = await sourceIn(tx, sourceId);
    list.splice(list.indexOf(record), 1);
    const timers = await tx.doc(TimerDoc);
    timers.timers = timers.timers.filter((timer) => timer.id !== timerId(sourceId));
    delete (await tx.doc(SourceCursorsDoc)).cursors[sourceId];
  }, context);
  await deps.secrets.set(WEBHOOK_SECRETS, sourceId, null);
}

export async function resetInboxWebhookSecret(deps: SourceDeps, sourceId: string, context: Context): Promise<InboxWebhookAccess> {
  const record = (await deps.harness.snapshot(SourcesDoc, context))?.sources.find((each) => each.id === sourceId);
  if (record === undefined) throw new Error(`No source ${sourceId}`);
  if (record.spec.kind !== "webhook") throw new Error("Only a webhook source has a secret");
  const secret = newSecret();
  await deps.secrets.set(WEBHOOK_SECRETS, sourceId, secret);
  return webhookAccess(deps, record, secret);
}

/**
 * Put one source event into its Inbox inside a commit; the source must still
 * be there and on. Returns whether it was recorded new.
 */
async function deliver(tx: Tx, sourceId: string, event: SourceEvent, followedOnly: boolean): Promise<"added" | "duplicate" | "dropped"> {
  const record = (await tx.doc(SourcesDoc)).sources.find((each) => each.id === sourceId);
  if (record === undefined || !record.enabled || record.spec.kind === "schedule") return "dropped";
  if (!(await tx.doc(IndexDoc)).projects.some((each) => each.path === record.project)) return "dropped";
  const source = record.spec.kind === "plugin" ? (`plugin:${record.spec.plugin}` as const) : ("webhook" as const);
  const recorded = recordSourceEvent(
    (await tx.doc(InboxDoc)).inboxes,
    record.project,
    {
      id: `${source}:${sourceId}:${event.id}`,
      source,
      ...(event.thread === undefined ? {} : { thread: event.thread }),
      ...(event.title === undefined ? {} : { title: event.title }),
      summary: event.summary,
      trusted: record.trusted,
    },
    followedOnly,
  );
  return recorded === undefined ? "dropped" : recorded.duplicate ? "duplicate" : "added";
}

/** Record (or with `undefined`, clear) a source's problem, committing only a change. */
async function setProblem(harness: Harness, sourceId: string, problem: string | undefined, context: Context): Promise<void> {
  const current = (await harness.snapshot(SourcesDoc, context))?.sources.find((each) => each.id === sourceId);
  if (current === undefined || current.problem === problem) return;
  await harness.commit(async (tx) => {
    const record = (await tx.doc(SourcesDoc)).sources.find((each) => each.id === sourceId);
    if (record === undefined) return;
    if (problem === undefined) delete record.problem;
    else record.problem = problem;
  }, context);
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What runs one enabled plugin source: its poll loop or its listener. */
interface Running {
  readonly loaded: LoadedSource;
  readonly filter: string;
  stop(): void;
}

/**
 * Runs every enabled plugin source: polls each on its interval (and once at
 * start), or keeps its listener open. A source whose plugin reloads, or whose
 * filter or switch changes, is restarted; one whose plugin is gone shows why.
 */
export async function startSourceRunner(deps: SourceDeps & { readonly context: Context; readonly log?: (line: string) => void }): Promise<{ close(): void }> {
  const { harness, context } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const running = new Map<string, Running>();
  let closed = false;

  const poll = (record: InboxSourceRecord & { spec: { kind: "plugin" } }, loaded: LoadedSource): Running => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const once = async (): Promise<void> => {
      if (!(await deps.sandboxAvailable())) {
        await setProblem(harness, record.id, NO_SANDBOX, context);
        return;
      }
      const cursor = (await harness.snapshot(SourceCursorsDoc, context))?.cursors[record.id];
      let result: Awaited<ReturnType<NonNullable<LoadedSource["poll"]>["run"]>>;
      try {
        result = await loaded.poll!.run(cursor, record.spec.filter);
      } catch (error) {
        if (!stopped) await setProblem(harness, record.id, message(error), context);
        return;
      }
      // Stopped meanwhile (turned off, removed, reloaded): the events come again from the stored cursor.
      if (stopped) return;
      await harness.commit(async (tx) => {
        for (const event of result.events) await deliver(tx, record.id, event, loaded.info.followedOnly === true);
        const cursors = (await tx.doc(SourceCursorsDoc)).cursors;
        if (result.cursor !== undefined && (await tx.doc(SourcesDoc)).sources.some((each) => each.id === record.id)) cursors[record.id] = result.cursor;
      }, context);
      await setProblem(harness, record.id, undefined, context);
    };
    const loop = (): void => {
      if (stopped || closed) return;
      void once()
        .catch((error: unknown) => {
          if (!closed) log(`Inbox source ${record.id} failed to poll: ${message(error)}`);
        })
        .finally(() => {
          if (!stopped && !closed) timer = setTimeout(loop, loaded.poll!.intervalMs);
        });
    };
    loop();
    return {
      loaded,
      filter: record.spec.filter,
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
  };

  const listen = (record: InboxSourceRecord & { spec: { kind: "plugin" } }, loaded: LoadedSource): Running => {
    let stopped = false;
    let stopListening: (() => void) | undefined;
    const emit = async (event: SourceEvent): Promise<void> => {
      if (stopped) return;
      if (!(await deps.sandboxAvailable())) throw new Error(NO_SANDBOX);
      await harness.commit((tx) => deliver(tx, record.id, event, loaded.info.followedOnly === true), context);
    };
    void (async () => {
      if (!(await deps.sandboxAvailable())) {
        await setProblem(harness, record.id, NO_SANDBOX, context);
        return;
      }
      try {
        const stop = await loaded.listen!(record.spec.filter, emit);
        if (stopped) stop();
        else {
          stopListening = stop;
          await setProblem(harness, record.id, undefined, context);
        }
      } catch (error) {
        if (!stopped) await setProblem(harness, record.id, message(error), context);
      }
    })().catch((error: unknown) => {
      if (!closed) log(`Inbox source ${record.id} failed to listen: ${message(error)}`);
    });
    return {
      loaded,
      filter: record.spec.filter,
      stop: () => {
        stopped = true;
        try {
          stopListening?.();
        } catch (error) {
          log(`Inbox source ${record.id} failed to stop: ${message(error)}`);
        }
      },
    };
  };

  let records: readonly InboxSourceRecord[] = [];
  const reconcile = (): void => {
    if (closed) return;
    const wanted = new Map<string, InboxSourceRecord & { spec: { kind: "plugin" } }>();
    for (const record of records) {
      if (record.enabled && record.spec.kind === "plugin") wanted.set(record.id, record as InboxSourceRecord & { spec: { kind: "plugin" } });
    }
    for (const [id, run] of running) {
      const record = wanted.get(id);
      const loaded = record === undefined ? undefined : deps.plugins()?.source(record.spec.plugin, record.spec.source);
      if (record === undefined || loaded !== run.loaded || record.spec.filter !== run.filter) {
        run.stop();
        running.delete(id);
      }
    }
    for (const [id, record] of wanted) {
      if (running.has(id)) continue;
      const loaded = deps.plugins()?.source(record.spec.plugin, record.spec.source);
      if (loaded === undefined) {
        const loadedPlugin = deps.plugins()?.info.some((each) => each.name === record.spec.plugin) === true;
        const problem = loadedPlugin ? `Plugin ${record.spec.plugin} has no source ${record.spec.source}` : `Plugin ${record.spec.plugin} is not loaded`;
        void setProblem(harness, id, problem, context).catch(() => {});
        continue;
      }
      running.set(id, loaded.poll !== undefined ? poll(record, loaded) : listen(record, loaded));
    }
  };

  await harness.commit(async (tx) => {
    await tx.doc(SourcesDoc);
    await tx.doc(SourceCursorsDoc);
  }, context);
  const watch = await harness.watchDoc(SourcesDoc, context);
  if (watch === undefined) throw new Error("The Inbox sources document is not available");
  records = watch.value?.sources ?? [];
  reconcile();
  watch.start((call) => {
    if (call.kind === "value") {
      records = call.value?.sources ?? [];
      reconcile();
    }
    return Promise.resolve();
  });
  const unsubscribe = deps.plugins()?.subscribe(reconcile);
  return {
    close() {
      closed = true;
      watch.stop();
      unsubscribe?.();
      for (const run of running.values()) run.stop();
      running.clear();
    },
  };
}

// --- The webhook endpoint ---

const LOOPBACK_V4 = /^127\./;
/** RFC 1918 private ranges and 100.64/10, the shared range Tailscale's tailnet addresses come from. */
const PRIVATE_V4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Whether a webhook may come from `address`: this machine, a private LAN, or a
 * tailnet (Tailscale's IPv4 range and IPv6 unique-local addresses). Public
 * addresses never reach the Inbox; a public webhook would have to go through
 * the relay, which only carries ciphertext (ADR-0008, ADR-0022).
 */
export function webhookPeerAllowed(address: string | undefined): boolean {
  if (address === undefined) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address;
  if (isIP(ip) === 4) return LOOPBACK_V4.test(ip) || PRIVATE_V4.test(ip);
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    // ::1, and fc00::/7 unique-local (Tailscale's fd7a:115c:a1e0::/48 among them).
    return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower);
  }
  return false;
}

/** Headers a reverse proxy adds: a request it forwarded may come from anywhere, whatever the socket says. */
const FORWARDED = ["forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "cf-connecting-ip", "true-client-ip"];

/** The signature the sender puts in `X-Pinomad-Signature`: `sha256=` and the hex HMAC of `<timestamp>.<body>`. */
export function webhookSignature(secret: string, timestamp: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

/** The body, or undefined once it passed `WEBHOOK_MAX_BYTES` (the rest is not read). */
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > WEBHOOK_MAX_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * `POST /inbox/<project>/events` (ADR-0051 §10). Returns false when the path
 * is not the endpoint's, so the listener serves it as before. Refused: a
 * peer outside the LAN and tailnet or a forwarded request (403), a body over
 * `WEBHOOK_MAX_BYTES` (413), an unknown or disabled source, a bad signature
 * or a timestamp outside `WEBHOOK_WINDOW_MS` (all the same 401), and with no
 * sandbox for Inbox runs (503). A repeated event id is accepted and changes
 * nothing, so a sender may retry.
 */
export async function handleWebhook(
  deps: SourceDeps & { readonly context: Context; readonly now?: () => number },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://host").pathname;
  const match = /^\/inbox\/([^/]+)\/events$/.exec(path);
  if (match === null) return false;
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    reply(response, 405, { error: "Use POST" });
    return true;
  }
  if (!webhookPeerAllowed(request.socket.remoteAddress) || FORWARDED.some((name) => request.headers[name] !== undefined)) {
    reply(response, 403, { error: "The Inbox takes webhooks only from this machine, its LAN and its tailnet" });
    request.resume();
    return true;
  }
  const body = await readBody(request);
  if (body === undefined) {
    reply(response, 413, { error: `The body is over ${WEBHOOK_MAX_BYTES} bytes` });
    request.destroy();
    return true;
  }

  const unauthorized = (): true => {
    reply(response, 401, { error: "Unknown source, bad signature or stale timestamp" });
    return true;
  };
  const sourceId = header(request, "x-pinomad-source");
  const timestamp = header(request, "x-pinomad-timestamp");
  const signature = header(request, "x-pinomad-signature");
  if (sourceId === undefined || timestamp === undefined || signature === undefined) return unauthorized();
  let project: string;
  try {
    project = decodeURIComponent(match[1]!);
  } catch {
    return unauthorized();
  }
  const record = (await deps.harness.snapshot(SourcesDoc, deps.context))?.sources.find((each) => each.id === sourceId);
  const secret = deps.secrets.get(WEBHOOK_SECRETS, sourceId);
  if (record === undefined || secret === undefined || record.spec.kind !== "webhook" || !record.enabled || inboxName(record.project) !== project) {
    return unauthorized();
  }
  const seconds = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) * 1000 : Number.NaN;
  if (!(Math.abs((deps.now?.() ?? Date.now()) - seconds) <= WEBHOOK_WINDOW_MS)) return unauthorized();
  const expected = Buffer.from(webhookSignature(secret, timestamp, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return unauthorized();

  if (!(await deps.sandboxAvailable())) {
    reply(response, 503, { error: NO_SANDBOX });
    return true;
  }
  let event: SourceEvent;
  try {
    event = parseWebhookEvent(JSON.parse(body.toString("utf8")) as unknown);
  } catch (error) {
    reply(response, 400, { error: message(error) });
    return true;
  }
  const outcome = await deps.harness.commit((tx) => deliver(tx, sourceId, event, false), deps.context);
  if (outcome === "dropped") return unauthorized();
  reply(response, 200, { accepted: true, duplicate: outcome === "duplicate" });
  return true;
}

/** `{ id, summary, thread?, title? }`, within the source event limits; nothing else is read. */
function parseWebhookEvent(value: unknown): SourceEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The body must be a JSON object");
  const fields = value as Record<string, unknown>;
  const text = (key: keyof typeof SOURCE_EVENT_LIMITS, required: boolean): string | undefined => {
    const field = fields[key];
    if (field === undefined && !required) return undefined;
    if (typeof field !== "string" || field.length === 0) throw new Error(`${key} must be a non-empty string`);
    if (field.length > SOURCE_EVENT_LIMITS[key]) throw new Error(`${key} is longer than ${SOURCE_EVENT_LIMITS[key]} characters`);
    return field;
  };
  const thread = text("thread", false);
  const title = text("title", false);
  return { id: text("id", true)!, summary: text("summary", true)!, ...(thread === undefined ? {} : { thread }), ...(title === undefined ? {} : { title }) };
}
