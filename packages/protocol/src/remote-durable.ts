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
  PROTOCOL_VERSION,
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
 * The host's hello announced a protocol this client does not speak. Before the
 * first view the ready promise rejects with it; after, the view's connection
 * goes "outdated" and no calls are sent — a host-served page reloads instead.
 */
export class ProtocolMismatchError extends Error {
  readonly host: number;
  readonly client: number;
  constructor(host: number, client: number) {
    super(`Host protocol mismatch: host speaks ${host}, this client speaks ${client}`);
    this.name = "ProtocolMismatchError";
    this.host = host;
    this.client = client;
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

class RemoteClient {
  readonly ready: Promise<RemoteDurable>;
  readonly #options: RemoteDurableOptions;
  readonly #listeners = new Set<() => void>();
  readonly #values = new Map<StreamName, unknown>();
  readonly #wanted = new Set<StreamName>(["conversations", "index", "devices", "mcp"]);
  #docs: readonly { readonly kind: string; readonly presentation?: PresentationType }[] = [];
  #toolPresentations: Record<string, PresentationType> = {};
  readonly #snapshotWaiters = new Map<StreamName, { resolve(): void; reject(error: Error): void }[]>();
  readonly #pending = new Map<number, Pending>();
  readonly #transport: FrameTransport;
  #connection: FrameConnection | undefined;
  #state: DurableView | undefined;
  #current: ConversationId | undefined;
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
      this.#update({ connection: "closed" });
      this.#notice("error", new UnauthorizedError().message);
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
    switch (frame.type) {
      case "hello": {
        if (frame.protocol !== PROTOCOL_VERSION) {
          // Reconnecting would loop on the same mismatch; mark closed first so
          // the close below stays terminal, then surface it the way the view
          // can tell it from a lost connection.
          const mismatch = new ProtocolMismatchError(frame.protocol, PROTOCOL_VERSION);
          this.#closed = true;
          if (this.#state === undefined) {
            this.#rejectReady(mismatch);
          } else {
            this.#update({ connection: "outdated" });
            this.#notice("error", mismatch.message);
          }
          this.#connection?.close();
          return;
        }
        this.#attempt = 0;
        this.#docs = frame.docs;
        this.#toolPresentations = frame.toolPresentations;
        if (this.#current !== undefined) for (const stream of this.#conversationStreams(this.#current)) this.#wanted.add(stream);
        for (const stream of this.#wanted) this.#send({ type: "subscribe", stream });
        if (this.#state !== undefined) {
          this.#update({ session: frame.session, models: frame.models, toolPresentations: frame.toolPresentations, connection: "connected" });
        }
        else this.#awaitFirstView(frame);
        return;
      }
      case "snapshot":
        if (!this.#wanted.has(frame.stream)) return;
        this.#values.set(frame.stream, frame.value);
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

  #refresh(): void {
    if (this.#state === undefined) return;
    const current = this.#current;
    const conversation =
      current === undefined ? undefined : (this.#values.get(conversationStream(current)) as ConversationView | undefined);
    const summaries = (this.#values.get("conversations") as ConversationSummary[] | undefined) ?? [];
    const index = (this.#values.get("index") as HostIndex | undefined) ?? { projects: [], conversations: [] };
    const devices = (this.#values.get("devices") as HostDevices | undefined)?.devices ?? [];
    const tasks = this.#wanted.has("tasks") ? (this.#values.get("tasks") as TaskGraph | undefined) : undefined;
    // In the host's order; a doc joins once its snapshot arrived.
    const docs: ExtensionDocView[] =
      current === undefined
        ? []
        : this.#docs.flatMap((doc) => {
            const stream = docStream(doc.kind, current);
            return this.#values.has(stream)
              ? [{ kind: doc.kind, presentation: doc.presentation, value: this.#values.get(stream) as JsonObject | null }]
              : [];
          });
    this.#update({
      conversation,
      organized: organize(index, summaries),
      home: current === undefined ? undefined : homeOf(index, summaries, current),
      checkout: current === undefined ? undefined : checkoutOf(index, summaries, current),
      tasks,
      docs,
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
      createConversation: (home, text, checkout) =>
        this.#command(async () => {
          const { conversationId } = await this.#call("createConversation", {
            home,
            text,
            requestId: newRequestId(),
            ...(checkout === undefined ? {} : { checkout }),
          });
          await this.#switch(conversationId);
        }),
      archive: (id, archived) =>
        this.#command(async () => {
          await this.#call("archive", { conversationId: id, archived });
          if (archived && id === this.#current) this.#unshow();
        }),
      submit: (text, whenBusy) =>
        this.#command(() => this.#call("submit", { conversationId: conversationId(), text, whenBusy, requestId: newRequestId() })),
      compact: (instructions) =>
        this.#command(() =>
          this.#call("compact", { conversationId: conversationId(), ...(instructions === undefined ? {} : { instructions }) }),
        ),
      // Not queued: it resolves once the conversation is idle.
      abort: () => {
        if (this.#current === undefined) {
          this.#notice("error", "No conversation selected");
          return Promise.resolve();
        }
        return this.#call("abort", { conversationId: conversationId() }).then(
            () => {},
            (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
          );
      },
      cycleThinking: () => this.#command(() => this.#call("cycleThinking", { conversationId: conversationId() })),
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
      fork: (entryId, prompt, removeTools) =>
        this.#command(async () => {
          const { conversationId: forked } = await this.#call("fork", {
            conversationId: conversationId(),
            entryId,
            ...(removeTools === undefined ? {} : { removeTools }),
          });
          // The fork is listed once its creating commit reaches the conversation list; switching does not need that.
          await this.#switch(forked);
          await this.#call("submit", { conversationId: forked, text: prompt, whenBusy: "followUp", requestId: newRequestId() });
        }),
      answer: (kind, requestId, answers) =>
        this.#command(() => this.#call("answer", { conversationId: conversationId(), kind, requestId, answers })),
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
    const next = this.#conversationStreams(id);
    for (const stream of next) this.#wanted.add(stream);
    const shown = Promise.all(next.map((stream) => this.#snapshot(stream)));
    for (const stream of next) this.#send({ type: "subscribe", stream });
    await shown;
    this.#current = id;
    for (const stream of previous === undefined ? [] : this.#conversationStreams(previous)) {
      this.#wanted.delete(stream);
      this.#values.delete(stream);
      this.#send({ type: "unsubscribe", stream });
    }
    this.#refresh();
  }

  /** Stop showing the current conversation, for example after archiving it. */
  #unshow(): void {
    const previous = this.#current;
    if (previous === undefined) return;
    this.#current = undefined;
    for (const stream of this.#conversationStreams(previous)) {
      this.#wanted.delete(stream);
      this.#values.delete(stream);
      this.#send({ type: "unsubscribe", stream });
    }
    this.#refresh();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#update({ connection: "closed" });
    this.#connection?.close();
  }
}
