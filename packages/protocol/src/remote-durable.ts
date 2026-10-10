import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationId, ConversationView, JsonObject, TaskGraph } from "@earendil-works/pi-durable";
import type { HostDevices } from "./devices.ts";
import type { McpStatus } from "./mcp.ts";
import { checkoutOf, homeOf, type HostIndex, organize } from "./organization.ts";
import type { PresentationType } from "./presentation.ts";
import {
  type CallMethod,
  type CallMethods,
  type ClientFrame,
  conversationStream,
  docStream,
  INVALID_FRAME_CLOSE_CODE,
  PROTOCOL,
  type ServerFrame,
  type StreamName,
  UNAUTHORIZED_CLOSE_CODE,
} from "./frames.ts";
import { type FrameConnection, type FrameTransport, webSocketTransport } from "./transport.ts";
import type {
  ConversationSummary,
  DurableController,
  DurableView,
  DurableViewSource,
  ExtensionDocView,
  Notice,
} from "./view.ts";

export type RemoteDurableOptions = (
  | {
      /** `ws://127.0.0.1:<port>` of a host's gateway. */
      readonly url: string;
      readonly token: string;
    }
  | { readonly transport: FrameTransport }
) & {
  readonly reconnectDelayMs?: { readonly min: number; readonly max: number };
};

export interface RemoteDurable {
  readonly view: DurableViewSource;
  readonly controller: DurableController;
  close(): void;
}

/**
 * A DurableViewSource and DurableController over a host's gateway. Holds no
 * Harness: each subscribed stream is a snapshot plus chord ops, and a lost
 * host is reconnected to and resubscribed from fresh snapshots, never replayed.
 */
export function connectRemoteDurable(options: RemoteDurableOptions): Promise<RemoteDurable> {
  return new RemoteClient(options).ready;
}

/**
 * The host closed with 4401: this client is not allowed (wrong token, or the
 * device is not paired or was revoked). Typed so a client UI can tell "rejected"
 * apart from "host unreachable" — conflating them would offer to wipe a good key.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized: this client is not allowed (wrong token, or the device is not paired or was revoked)");
    this.name = "UnauthorizedError";
  }
}

/**
 * The host's hello announced a major this client does not speak (ADR-0018).
 * Before the first view the ready promise rejects with it; after, the view's
 * connection goes "outdated" and no calls are sent — a host-served page
 * reloads instead.
 */
export class ProtocolMismatchError extends Error {
  readonly hostMajor: number;
  readonly clientMajor: number;
  /** Packaged release version the host announced; absent for a source checkout. */
  readonly hostVersion?: string;
  /** Which side is behind: `client-older` → update the app; `host-older` → upgrade the host. */
  readonly direction: "client-older" | "host-older";
  constructor(hostMajor: number, clientMajor: number, hostVersion?: string) {
    const direction = hostMajor > clientMajor ? ("client-older" as const) : ("host-older" as const);
    super(
      direction === "client-older"
        ? `Client out of date: the host speaks protocol major ${hostMajor}, this client speaks ${clientMajor}`
        : `Host out of date: this client speaks protocol major ${clientMajor}, the host speaks ${hostMajor}`,
    );
    this.name = "ProtocolMismatchError";
    this.hostMajor = hostMajor;
    this.clientMajor = clientMajor;
    if (hostVersion !== undefined) this.hostVersion = hostVersion;
    this.direction = direction;
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

class RemoteClient {
  readonly ready: Promise<RemoteDurable>;
  readonly #options: RemoteDurableOptions;
  readonly #listeners = new Set<() => void>();
  readonly #values = new Map<StreamName, unknown>();
  readonly #wanted = new Set<StreamName>(["conversations", "index", "devices", "mcp"]);
  // Streams whose CURRENT subscription delivered a snapshot. A wanted-but-not-
  // fresh stream (after reconnect, before the host answers) has a stale value —
  // #acquire must wait for it, never serve the old one.
  readonly #fresh = new Set<StreamName>();
  #docs: readonly { readonly kind: string; readonly presentation?: PresentationType }[] = [];
  #toolPresentations: Record<string, PresentationType> = {};
  readonly #snapshotWaiters = new Map<StreamName, { resolve(): void; reject(error: Error): void }[]>();
  readonly #pending = new Map<number, Pending>();
  readonly #transport: FrameTransport;
  #connection: FrameConnection | undefined;
  #state: DurableView | undefined;
  #current: ConversationId | undefined;
  #side: ConversationId | undefined;
  #nextCall = 1;
  #nextNotice = 1;
  #attempt = 0;
  #closed = false;
  #notifying = false;
  #commands = Promise.resolve();
  #resolveReady!: (value: RemoteDurable) => void;
  #rejectReady!: (error: Error) => void;

  constructor(options: RemoteDurableOptions) {
    this.#options = options;
    this.#transport = "transport" in options ? options.transport : webSocketTransport(options.url, options.token);
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#open();
  }

  #open(): void {
    const connection: FrameConnection = this.#transport.open({
      message: (data) => {
        if (this.#connection === connection) this.#receive(JSON.parse(data) as ServerFrame);
      },
      closed: (code, reason) => this.#lost(connection, code, reason),
    });
    this.#connection = connection;
  }

  #lost(connection: FrameConnection, code: number, reason: string | undefined): void {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    for (const pending of this.#pending.values()) pending.reject(new Error("Disconnected from host"));
    this.#pending.clear();
    if (this.#state === undefined) {
      this.#closed = true;
      this.#rejectReady(
        code === UNAUTHORIZED_CLOSE_CODE
          ? new UnauthorizedError()
          : new Error(reason ?? `Could not connect to ${this.#transport.label}`),
      );
      return;
    }
    if (this.#closed) return;
    if (code === UNAUTHORIZED_CLOSE_CODE) {
      this.#closed = true;
      this.#update({ connection: "closed", unauthorized: true });
      this.#notice("error", new UnauthorizedError().message);
      return;
    }
    // 4400 is terminal like 4401 (ADR-0018 §4): the host rejected a malformed
    // frame from this client, and a reconnect would send the same ones. A
    // plain 1008 (a failed secure handshake, say) still reconnects below.
    if (code === INVALID_FRAME_CLOSE_CODE) {
      this.#closed = true;
      this.#update({ connection: "closed" });
      this.#notice(
        "error",
        `The host rejected a malformed frame from this client${reason === undefined ? "" : `: ${reason}`}`,
      );
      return;
    }
    this.#update({ connection: "reconnecting" });
    const { min, max } = this.#options.reconnectDelayMs ?? { min: 200, max: 2000 };
    const delay = Math.min(max, min * 2 ** this.#attempt++);
    setTimeout(() => {
      if (!this.#closed) this.#open();
    }, delay);
  }

  #send(frame: ClientFrame): void {
    this.#connection?.send(JSON.stringify(frame));
  }

  #receive(frame: ServerFrame): void {
    // ADR-0018 §4: a newer host's frames — including types and shapes this
    // build does not know — are ignored, never fatal.
    if (frame === null || typeof frame !== "object") return;
    switch (frame.type) {
      case "hello": {
        // Hosts up to v4 announced a bare integer; the frame type says
        // ProtocolVersion, so read it defensively rather than widen the type.
        const announced: unknown = frame.protocol;
        const hostMajor =
          typeof announced === "number"
            ? announced
            : announced !== null && typeof announced === "object"
              ? (announced as { major?: unknown }).major
              : undefined;
        if (hostMajor !== PROTOCOL.major) {
          // Reconnecting would loop on the same mismatch; mark closed first so
          // the close below stays terminal, then surface it the way the view
          // can tell it from a lost connection.
          const mismatch = new ProtocolMismatchError(
            typeof hostMajor === "number" ? hostMajor : Number.NaN,
            PROTOCOL.major,
            frame.hostVersion,
          );
          this.#closed = true;
          if (this.#state === undefined) {
            this.#rejectReady(mismatch);
          } else {
            this.#update({
              connection: "outdated",
              protocolMismatch: {
                hostMajor: mismatch.hostMajor,
                clientMajor: mismatch.clientMajor,
                ...(mismatch.hostVersion === undefined ? {} : { hostVersion: mismatch.hostVersion }),
                direction: mismatch.direction,
              },
            });
            this.#notice("error", mismatch.message);
          }
          this.#connection?.close();
          return;
        }
        this.#attempt = 0;
        this.#docs = frame.docs;
        this.#toolPresentations = frame.toolPresentations;
        this.#fresh.clear();
        if (this.#current !== undefined) for (const stream of this.#conversationStreams(this.#current)) this.#wanted.add(stream);
        if (this.#side !== undefined) for (const stream of this.#conversationStreams(this.#side)) this.#wanted.add(stream);
        for (const stream of this.#wanted) this.#send({ type: "subscribe", stream });
        if (this.#state !== undefined) {
          this.#update({
            session: frame.session,
            models: frame.models,
            toolPresentations: frame.toolPresentations,
            defaults: frame.defaults ?? {},
            connection: "connected",
          });
        }
        else this.#awaitFirstView(frame);
        return;
      }
      case "snapshot":
        if (!this.#wanted.has(frame.stream)) return;
        this.#values.set(frame.stream, frame.value);
        this.#fresh.add(frame.stream);
        this.#refresh();
        for (const waiter of this.#snapshotWaiters.get(frame.stream)?.splice(0) ?? []) waiter.resolve();
        return;
      case "ops":
        if (!this.#wanted.has(frame.stream) || !this.#values.has(frame.stream)) return;
        this.#values.set(frame.stream, applyImmutable(this.#values.get(frame.stream), frame.ops));
        this.#refresh();
        return;
      case "ended":
        this.#wanted.delete(frame.stream);
        this.#values.delete(frame.stream);
        this.#fresh.delete(frame.stream);
        for (const waiter of this.#snapshotWaiters.get(frame.stream)?.splice(0) ?? []) {
          waiter.reject(new Error(`Stream ${frame.stream} ended: ${frame.reason}`));
        }
        this.#refresh();
        return;
      case "result": {
        const pending = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        if (frame.ok) pending?.resolve(frame.value);
        else pending?.reject(new Error(frame.error));
        return;
      }
      case "notice":
        this.#notice(frame.level, frame.message);
        return;
    }
  }

  #awaitFirstView(hello: Extract<ServerFrame, { type: "hello" }>): void {
    void Promise.all([this.#snapshot("conversations"), this.#snapshot("index"), this.#snapshot("devices"), this.#snapshot("mcp")]).then(() => {
      this.#state = {
        session: hello.session,
        organized: { chats: [], projects: [] },
        models: hello.models,
        defaults: hello.defaults ?? {},
        notices: [],
        connection: "connected",
        docs: [],
        toolPresentations: hello.toolPresentations,
        devices: [],
        mcp: null,
      };
      this.#refresh();
      this.#resolveReady({ view: this.#viewSource(), controller: this.#controller(), close: () => this.#close() });
    });
  }

  /** Resolve at the stream's next snapshot; reject if the host ends it instead. */
  #snapshot(stream: StreamName): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.#snapshotWaiters.get(stream) ?? [];
      waiters.push({ resolve, reject });
      this.#snapshotWaiters.set(stream, waiters);
    });
  }

  /** The streams that show one conversation: its view and its documents. */
  #conversationStreams(id: ConversationId): StreamName[] {
    return [conversationStream(id), ...this.#docs.map((doc) => docStream(doc.kind, id))];
  }

  /**
   * Subscribe to the streams a conversation slot needs. Streams another slot
   * already wants stay put — subscribing again would be a no-op on the host,
   * and their live values carry over (no snapshot wait).
   */
  async #acquire(id: ConversationId): Promise<void> {
    const missing = this.#conversationStreams(id).filter((stream) => !this.#wanted.has(stream));
    // Wanted but not fresh: already subscribed (the side may share it) yet the
    // host has not answered this connection — waiting hands us its new value,
    // never the stale one left over from before the reconnect.
    const stale = this.#conversationStreams(id).filter((stream) => this.#wanted.has(stream) && !this.#fresh.has(stream));
    const shown = Promise.all([...missing, ...stale].map((stream) => this.#snapshot(stream)));
    for (const stream of missing) {
      this.#wanted.add(stream);
      this.#send({ type: "subscribe", stream });
    }
    await shown;
  }

  /** Release the streams of one slot's conversation the other slot does not still need. */
  #release(id: ConversationId, other: ConversationId | undefined): void {
    const keep = new Set<StreamName>(other === undefined ? [] : this.#conversationStreams(other));
    for (const stream of this.#conversationStreams(id)) {
      if (keep.has(stream)) continue;
      this.#wanted.delete(stream);
      this.#values.delete(stream);
      this.#fresh.delete(stream);
      this.#send({ type: "unsubscribe", stream });
    }
  }

  /** `id` is `ancestor` or sits under it via `parent` links in the summaries. */
  #descendsFrom(id: ConversationId, ancestor: ConversationId): boolean {
    const summaries = (this.#values.get("conversations") as ConversationSummary[] | undefined) ?? [];
    const parentOf = new Map(summaries.map((summary) => [summary.id, summary.parent]));
    let cursor: ConversationId | undefined = id;
    for (let depth = 0; cursor !== undefined && depth < 8; depth++) {
      if (cursor === ancestor) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  }

  /** One shown conversation's extension docs, in the host's order. */
  #docsOf(id: ConversationId): ExtensionDocView[] {
    return this.#docs.flatMap((doc) => {
      const stream = docStream(doc.kind, id);
      return this.#values.has(stream)
        ? [{ kind: doc.kind, presentation: doc.presentation, value: this.#values.get(stream) as JsonObject | null }]
        : [];
    });
  }

  #refresh(): void {
    if (this.#state === undefined) return;
    const current = this.#current;
    const side = this.#side;
    const conversation =
      current === undefined ? undefined : (this.#values.get(conversationStream(current)) as ConversationView | undefined);
    const summaries = (this.#values.get("conversations") as ConversationSummary[] | undefined) ?? [];
    const index = (this.#values.get("index") as HostIndex | undefined) ?? { projects: [], conversations: [] };
    const devices = (this.#values.get("devices") as HostDevices | undefined)?.devices ?? [];
    const tasks = this.#wanted.has("tasks") ? (this.#values.get("tasks") as TaskGraph | undefined) : undefined;
    this.#update({
      conversation,
      organized: organize(index, summaries),
      home: current === undefined ? undefined : homeOf(index, summaries, current),
      checkout: current === undefined ? undefined : checkoutOf(index, summaries, current),
      tasks,
      docs: current === undefined ? [] : this.#docsOf(current),
      side:
        side === undefined
          ? undefined
          : {
              id: side,
              conversation: this.#values.get(conversationStream(side)) as ConversationView | undefined,
              docs: this.#docsOf(side),
            },
      devices,
      mcp: (this.#values.get("mcp") as McpStatus | null | undefined) ?? null,
    });
  }

  #update(patch: Partial<DurableView>): void {
    if (this.#state === undefined) return;
    this.#state = { ...this.#state, ...patch };
    if (this.#notifying) return;
    this.#notifying = true;
    // One render per burst of frames, as the in-process view source does.
    queueMicrotask(() => {
      this.#notifying = false;
      for (const listener of this.#listeners) listener();
    });
  }

  #notice(level: Notice["level"], message: string): void {
    if (this.#state === undefined) return;
    this.#update({ notices: [...this.#state.notices, { id: this.#nextNotice++, level, message }].slice(-20) });
  }

  #call<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
    if (this.#connection === undefined || this.#state?.connection !== "connected") {
      return Promise.reject(new Error("Not connected to the host"));
    }
    const id = this.#nextCall++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#send({ type: "call", id, method, args } as ClientFrame);
    });
  }

  /** Serialized like the in-process controller, so toggles and switches apply in order; failures become notices. */
  #command(operation: () => Promise<unknown>): Promise<void> {
    this.#commands = this.#commands
      .then(operation)
      .then(
        () => {},
        (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
      );
    return this.#commands;
  }

  #viewSource(): DurableViewSource {
    return {
      current: () => this.#state!,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  #controller(): DurableController {
    // crypto.randomUUID exists only in secure contexts; a phone on http://<lan-ip> has none.
    const newRequestId = (): string =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const conversationId = (): ConversationId => {
      if (this.#current === undefined) throw new Error("No conversation selected");
      return this.#current;
    };
    return {
      addProject: (path) => this.#command(() => this.#call("addProject", { path })),
      removeProject: (path) => this.#command(() => this.#call("removeProject", { path })),
      createConversation: (home, text, options) =>
        this.#command(async () => {
          const { conversationId } = await this.#call("createConversation", {
            home,
            text,
            requestId: newRequestId(),
            ...(options?.checkout === undefined ? {} : { checkout: options.checkout }),
            ...(options?.model === undefined ? {} : { model: options.model }),
            ...(options?.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
          });
          await this.#switch(conversationId);
        }),
      archive: (id, archived) =>
        this.#command(async () => {
          await this.#call("archive", { conversationId: id, archived });
          if (archived && id === this.#current) this.#unshow();
          // Archiving a root takes its descendants with it — a side into that
          // family is gone too.
          if (archived && this.#side !== undefined && this.#descendsFrom(this.#side, id)) await this.#showSide(undefined);
        }),
      submit: (text, whenBusy, target) =>
        this.#command(() =>
          this.#call("submit", { conversationId: target ?? conversationId(), text, whenBusy, requestId: newRequestId() }),
        ),
      compact: (instructions) =>
        this.#command(() =>
          this.#call("compact", { conversationId: conversationId(), ...(instructions === undefined ? {} : { instructions }) }),
        ),
      // Not queued: it resolves once the conversation is idle.
      abort: (target) => {
        const targetConversation = target ?? this.#current;
        if (targetConversation === undefined) {
          this.#notice("error", "No conversation selected");
          return Promise.resolve();
        }
        return this.#call("abort", { conversationId: targetConversation }).then(
            () => {},
            (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
          );
      },
      setThinkingLevel: (level) => this.#command(() => this.#call("setThinkingLevel", { conversationId: conversationId(), level })),
      setModel: (model) => this.#command(() => this.#call("setModel", { conversationId: conversationId(), model })),
      toggleTasks: () =>
        this.#command(async () => {
          if (this.#wanted.delete("tasks")) {
            this.#send({ type: "unsubscribe", stream: "tasks" });
            this.#values.delete("tasks");
            this.#refresh();
            return;
          }
          this.#wanted.add("tasks");
          const shown = this.#snapshot("tasks");
          this.#send({ type: "subscribe", stream: "tasks" });
          await shown;
        }),
      switchConversation: (id) => this.#command(() => this.#switch(id)),
      showSide: (id) => this.#command(() => this.#showSide(id)),
      fork: (entryId, prompt, removeTools, options) =>
        this.#command(async () => {
          const { conversationId: forked } = await this.#call("fork", {
            conversationId: conversationId(),
            entryId,
            ...(removeTools === undefined ? {} : { removeTools }),
          });
          // The fork is listed once its creating commit reaches the conversation list; switching does not need that.
          if (options?.show === "side") await this.#showSide(forked);
          else await this.#switch(forked);
          await this.#call("submit", { conversationId: forked, text: prompt, whenBusy: "followUp", requestId: newRequestId() });
        }),
      answer: (kind, requestId, answers, target) =>
        this.#command(() => this.#call("answer", { conversationId: target ?? conversationId(), kind, requestId, answers })),
      // Queued like other commands, but the caller needs the result: queue it
      // the way createPairing does and return the promise.
      changes: () => {
        const call = this.#commands.then(() => this.#call("changes", { conversationId: conversationId() }));
        this.#commands = call.then(
          () => {},
          () => {},
        );
        return call;
      },
      // Queued like other commands, but the caller owns the error: the dialog
      // shows it, so no notice.
      createPairing: () => {
        const pairing = this.#commands.then(() => this.#call("createPairing", {}));
        this.#commands = pairing.then(
          () => {},
          () => {},
        );
        return pairing;
      },
      revokeDevice: (publicKey) => this.#command(() => this.#call("revokeDevice", { publicKey })),
    };
  }

  async #switch(id: ConversationId): Promise<void> {
    const previous = this.#current;
    if (id === previous) return;
    await this.#acquire(id);
    this.#current = id;
    if (previous !== undefined) this.#release(previous, this.#side);
    this.#refresh();
  }

  /** Stop showing the current conversation, for example after archiving it. */
  #unshow(): void {
    const previous = this.#current;
    if (previous === undefined) return;
    this.#current = undefined;
    this.#release(previous, this.#side);
    this.#refresh();
  }

  /** Show a second conversation beside the main one, or close it. */
  async #showSide(id: ConversationId | undefined): Promise<void> {
    const previous = this.#side;
    if (id === previous) return;
    if (id !== undefined) await this.#acquire(id);
    this.#side = id;
    if (previous !== undefined) this.#release(previous, this.#current);
    this.#refresh();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#update({ connection: "closed" });
    this.#connection?.close();
  }
}
