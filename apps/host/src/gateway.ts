import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type AgentState,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { WebSocket, WebSocketServer } from "ws";
import { Value } from "typebox/value";
import { QuestionSchema, type PresentationType } from "@pinomad/protocol/presentation.ts";
import {
  type CallMethod,
  type CallMethods,
  type ClientFrame,
  parseClientFrame,
  INVALID_FRAME_CLOSE_CODE,
  PROTOCOL,
  type ServerFrame,
  type StreamName,
  UNAUTHORIZED_CLOSE_CODE,
} from "@pinomad/protocol/frames.ts";
import type { McpStatus } from "@pinomad/protocol/mcp.ts";
import type { ConversationSummary, ModelSummary, Notice, SessionInfo } from "@pinomad/protocol/view.ts";
import { type HandshakeResult, type KeyPair, respondIK } from "@pinomad/protocol/noise.ts";
import {
  decodeClientHello,
  encodeHostHello,
  SecureSession,
  SECURE_PROLOGUE,
  toBase64Url,
} from "@pinomad/protocol/secure-channel.ts";
import type { ExtensionDoc } from "./builtin-extension.ts";
import { branchSuffix, changesOf, checkoutAt, gitBase, snapshotOf, worktreeBranch, worktreeExists, worktreePath } from "./checkout.ts";
import { packagedVersion } from "./distribution.ts";
import { isRegistered, registerDevice, revokeDevice, DevicesDoc, type PairingOffers } from "./devices.ts";
import { type RelayLink, relayWsBase, startRelayLink } from "./relay-link.ts";
import { serveWebClient } from "./web-client.ts";
import {
  addProject,
  archive,
  cleanupArchivedWorktrees,
  type ConversationDefaults,
  createConversation,
  IndexDoc,
  removeProject,
} from "./organization.ts";

const context: Context = BACKGROUND_CONTEXT;

/**
 * Fork calls on one host serialize here (ADR-0019 §3): the one-fork-per-message
 * check reads records inside a fresh commit, which is only safe if no second
 * fork can land between the check and the create.
 */
const forkTails = new WeakMap<Harness, Promise<unknown>>();

function serializedFork<T>(harness: Harness, work: () => Promise<T>): Promise<T> {
  const next = (forkTails.get(harness) ?? Promise.resolve()).then(work, work);
  const settled = next.then(
    () => {},
    () => {},
  );
  forkTails.set(harness, settled);
  void settled.then(() => {
    if (forkTails.get(harness) === settled) forkTails.delete(harness);
  });
  return next;
}

/** Secure-channel access: the IK handshake gate plus where sockets come from. */
export interface SecureGatewayOptions {
  /** The host's long-term X25519 identity (server side of the IK handshake). */
  readonly hostKey: KeyPair;
  readonly offers: PairingOffers;
  /** How long a new socket may sit before message 1 arrives; default 10 s. */
  readonly handshakeTimeoutMs?: number;
  /** The 0.0.0.0 listener (LAN direct; user's own tunnel via publicUrl). */
  readonly lan?: { readonly port: number; readonly publicUrl?: string };
  /** Outbound link to a self-hosted relay (ADR-0008 phase 2). */
  readonly relay?: {
    readonly origin: string;
    readonly signingKey: { readonly secretKey: Uint8Array; readonly publicKey: Uint8Array };
    readonly reconnectDelayMs?: { readonly min: number; readonly max: number };
    readonly pingIntervalMs?: number;
  };
}

export interface GatewayOptions {
  readonly harness: Harness;
  readonly models: Models;
  readonly modelSummaries: () => readonly ModelSummary[];
  readonly session: SessionInfo;
  readonly token: string;
  readonly port: number;
  /** Exact browser origins permitted to connect. Native clients send no Origin. */
  readonly browserOrigins?: readonly string[];
  /** Chat checkouts live under `<dataDir>/chats`. */
  readonly dataDir: string;
  /** Agent settings applied to conversations created through the gateway. */
  readonly defaults: ConversationDefaults;
  /** MCP server status source; absent → the `mcp` stream snapshots `null` (ADR-0012 §8). */
  readonly mcp?: { readonly value: McpStatus; subscribe(listener: (value: McpStatus) => void): () => void };
  /** Conversation documents offered as `doc:<kind>:<conversationId>` streams. */
  readonly docs?: readonly ExtensionDoc[];
  /** Tool name → presentation of its result `details`, announced in the hello. */
  readonly toolPresentations?: Record<string, PresentationType>;
  /** Built web client served over plain HTTP on both listeners; absent → 503. */
  readonly webRoot?: string;
  /** Set to accept secure-channel clients, on LAN and/or via a relay. */
  readonly secure?: SecureGatewayOptions;
}

export interface Gateway {
  readonly url: string;
  /** Present when the remote listener is on. */
  readonly remote?: { readonly url: string; readonly advertiseUrl: string };
  /** Present when the host dialed out to a relay. */
  readonly relay?: RelayLink;
  /** Tell every client, for example a Harness report. */
  broadcast(level: Notice["level"], message: string): void;
  close(): Promise<void>;
}

/**
 * The loopback listener's secure-channel path (ADR-0020 §2): requests here
 * get the IK handshake instead of the token + Origin gate, so a paired device
 * on this machine never needs the token.
 */
export const LOOPBACK_SECURE_PATH = "/secure";

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const conversations = await ConversationList.open(options.harness);
  // The loopback port also serves the built web client: in service mode there
  // is no vite dev server to reach it through (ADR-0009 §7).
  const http = createServer((request, response) => {
    void serveWebClient(request, response, options.webRoot).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1");
  });
  const { port } = http.address() as AddressInfo;
  // A page this listener itself served is trusted by construction; the bound
  // port can be ephemeral, so the origin is computed after listen.
  const browserOrigins = [...(options.browserOrigins ?? []), `http://127.0.0.1:${port}`];
  const clients = new Set<GatewayClient>();
  const broadcast = (level: Notice["level"], message: string): void => {
    for (const client of clients) client.send({ type: "notice", level, message });
  };
  let remote: { url: string; advertiseUrl: string; close(): Promise<void> } | undefined;
  let relay: RelayLink | undefined;
  const register = (connection: GatewayConnection, devicePublicKey?: string): void => {
    const client = new GatewayClient(connection, options, conversations, {
      devicePublicKey,
      closed: (self) => {
        clients.delete(self);
        void self.dispose();
      },
      closeDevice: (publicKey) => {
        for (const client of clients) {
          if (client.devicePublicKey === publicKey) client.closeConnection(UNAUTHORIZED_CLOSE_CODE, "device revoked");
        }
      },
      createPairing: () => {
        const spec = options.secure;
        if (spec === undefined) return undefined;
        const { secret, expiresAt } = spec.offers.create();
        const pair = `pair=${toBase64Url(spec.hostKey.publicKey)}.${secret}`;
        // The relay wins: a link through it works from any network, while the
        // LAN URL only reaches devices that can already see the host.
        if (relay !== undefined) {
          const target = `${relayWsBase(relay.origin)}/c/${relay.hostId}`;
          return { url: `${relay.origin}/#${pair}&url=${encodeURIComponent(target)}`, expiresAt };
        }
        if (remote !== undefined) return { url: `${remote.advertiseUrl}/#${pair}`, expiresAt };
        // ADR-0020 §4: no remote listener — the last resort is the loopback
        // /secure path, which only a client on this machine can use.
        const target = `ws://127.0.0.1:${port}${LOOPBACK_SECURE_PATH}`;
        return { url: `http://127.0.0.1:${port}/#${pair}&url=${encodeURIComponent(target)}`, expiresAt };
      },
    });
    clients.add(client);
  };
  server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    socket.on("error", () => socket.terminate());
    const url = new URL(request.url ?? "/", "ws://127.0.0.1");
    if (url.pathname === LOOPBACK_SECURE_PATH) {
      // The Noise handshake is the authentication; the token and Origin gate
      // below must not touch this path (ADR-0020 §2).
      const secure = options.secure;
      if (secure === undefined) {
        socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
        return;
      }
      secureHandshake(socket, secure, options.harness, register);
      return;
    }
    const token = url.searchParams.get("token");
    const origin = request.headers.origin;
    if (token !== options.token || (origin !== undefined && !browserOrigins.includes(origin))) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
      return;
    }
    register(tokenConnection(socket));
  });

  remote = await startRemote(options, register);
  const secure = options.secure;
  if (secure?.relay !== undefined) {
    // `link` is assigned before any state change can fire — transitions only
    // ever happen from async socket events.
    let link!: RelayLink;
    link = startRelayLink({
      origin: secure.relay.origin,
      signingKey: secure.relay.signingKey,
      accept: (socket) => secureHandshake(socket, secure, options.harness, register),
      onStateChange: (state) => {
        // stdout JSON lines in the same style as main.ts's `ready` event, so
        // journalctl shows whether the host is registered with its relay.
        if (state.status === "registered") {
          console.log(JSON.stringify({ event: "relay", status: "registered", origin: link.origin, hostId: link.hostId }));
        } else if (state.status === "connecting") {
          console.log(JSON.stringify({ event: "relay", status: "connecting", origin: link.origin }));
        } else {
          broadcast("warning", state.reason);
          console.error(state.reason);
        }
      },
      ...(secure.relay.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: secure.relay.reconnectDelayMs }),
      ...(secure.relay.pingIntervalMs === undefined ? {} : { pingIntervalMs: secure.relay.pingIntervalMs }),
    });
    relay = link;
  }
  return {
    url: `ws://127.0.0.1:${port}`,
    ...(remote === undefined ? {} : { remote: { url: remote.url, advertiseUrl: remote.advertiseUrl } }),
    ...(relay === undefined ? {} : { relay }),
    broadcast,
    async close() {
      await relay?.close();
      conversations.dispose();
      await Promise.all([...clients].map((client) => client.dispose()));
      for (const socket of server.clients) socket.terminate();
      await remote?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/**
 * One authenticated connection to a client, independent of carrier: the loopback
 * token WebSocket or a secure-channel socket after its IK handshake.
 */
interface GatewayConnection {
  /** True while the connection can still carry frames. */
  readonly open: boolean;
  /** A text frame to the client; resolves when the transport accepted it. */
  send(text: string): Promise<void>;
  close(code: number, reason?: string): void;
  /** Wire inbound events; called once by GatewayClient. */
  handle(handlers: { message(text: string): void; closed(): void }): void;
}

/** The loopback listener's connection: plain text frames, token-gated at upgrade. */
function tokenConnection(socket: WebSocket): GatewayConnection {
  return {
    get open() {
      return socket.readyState === WebSocket.OPEN;
    },
    send: (text) =>
      socket.readyState === WebSocket.OPEN
        ? new Promise((resolve) => socket.send(text, () => resolve()))
        : Promise.resolve(),
    close: (code, reason) => socket.close(code, reason),
    handle(handlers) {
      socket.on("message", (data) => handlers.message(String(data)));
      socket.once("close", () => handlers.closed());
    },
  };
}

/** The remote listener's connection after IK: binary records sealed by the session. */
function secureConnection(socket: WebSocket, session: SecureSession): GatewayConnection {
  return {
    get open() {
      return socket.readyState === WebSocket.OPEN;
    },
    send: (text) =>
      socket.readyState === WebSocket.OPEN
        ? new Promise((resolve) => {
            // Backpressure like the token connection: hold the next frame until
            // the transport has accepted the last chunk of this one.
            const chunks = session.seal(text);
            chunks.forEach((chunk, index) =>
              socket.send(chunk, index === chunks.length - 1 ? () => resolve() : undefined)
            );
          })
        : Promise.resolve(),
    close: (code, reason) => socket.close(code, reason),
    handle(handlers) {
      socket.on("message", (data: Buffer) => {
        try {
          const text = session.open(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          if (text !== undefined) handlers.message(text);
        } catch {
          socket.close(1008, "corrupt secure record");
        }
      });
      socket.once("close", () => handlers.closed());
    },
  };
}

const RFC1918 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PREFERRED_NAME = /^(?:en|eth|wlan|wl)/;
// VPN tunnels and virtual bridges also carry RFC1918-looking addresses; a QR
// code pointing at 198.18.x (fake-ip range) or an utun interface is unreachable.
const VIRTUAL_NAME = /^(?:utun|tun|tap|wg|ppp|ipsec|bridge|docker|veth|vmnet|llw|awdl)/;

/**
 * The LAN IPv4 to advertise in pairing URLs: a real ethernet/wifi interface
 * with a private address first, then any non-virtual interface with one.
 * Link-local, fake-ip (198.18/15), and public addresses all fail the RFC1918
 * test, so they can never win. Undefined → caller falls back to 127.0.0.1.
 */
export function pickLanAddress(interfaces: ReturnType<typeof networkInterfaces>): string | undefined {
  let fallback: string | undefined;
  for (const [name, addresses] of Object.entries(interfaces)) {
    const candidate = (addresses ?? []).find(
      (address) => address.family === "IPv4" && !address.internal && RFC1918.test(address.address),
    );
    if (candidate === undefined) continue;
    if (PREFERRED_NAME.test(name)) return candidate.address;
    if (!VIRTUAL_NAME.test(name) && fallback === undefined) fallback = candidate.address;
  }
  return fallback;
}

/**
 * The IK handshake gate on a fresh secure socket — LAN listener or relay
 * accept. Anything but one binary message 1 — text frames, a second message
 * while admission is pending — is a protocol violation closed with 1008. Registered devices pass directly; new
 * devices must present a live pairing offer.
 */
function secureHandshake(
  socket: WebSocket,
  secure: SecureGatewayOptions,
  harness: Harness,
  register: (connection: GatewayConnection, devicePublicKey: string) => void,
): void {
  socket.on("error", () => socket.terminate());
  const responder = respondIK({ prologue: SECURE_PROLOGUE, static: secure.hostKey });
  let settled = false;
  let deciding = false;
  const timeout = setTimeout(() => socket.close(1008, "handshake timeout"), secure.handshakeTimeoutMs ?? 10_000);
  socket.once("close", () => clearTimeout(timeout));

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (settled) return;
    if (deciding || !isBinary) {
      socket.close(1008, "expected handshake");
      return;
    }
    deciding = true;
    void admit()
      .then((admitted) => {
        if (admitted === undefined) return;
        settled = true;
        // The deadline only governs the handshake; a settled session must not
        // be killed ten seconds later.
        clearTimeout(timeout);
        const session = new SecureSession(admitted.result);
        socket.send(admitted.message);
        register(secureConnection(socket, session), admitted.deviceKey);
      })
      .catch(() => socket.close(1011, "handshake failed"));
    async function admit(): Promise<{ result: HandshakeResult; message: Uint8Array; deviceKey: string } | undefined> {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      let hello;
      let remoteStatic: Uint8Array;
      try {
        const opened = responder.readMessage1(bytes);
        remoteStatic = opened.remoteStatic;
        hello = decodeClientHello(opened.payload);
      } catch {
        socket.close(1008, "bad handshake");
        return undefined;
      }
      const deviceKey = toBase64Url(remoteStatic);
      if (!(await isRegistered(harness, deviceKey, context))) {
        // A registered device with `pair` present still passes above — a retry
        // after a lost message 2 must not spend another offer.
        if (hello.pair === undefined || !secure.offers.consume(hello.pair.secret)) {
          socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
          return undefined;
        }
        await registerDevice(harness, { publicKey: deviceKey, name: hello.pair.name }, context);
      }
      const { message, result } = responder.writeMessage2(encodeHostHello({ v: 1 }));
      return { result, message, deviceKey };
    }
  });
}

/** The 0.0.0.0 listener: plain HTTP for the web client + secure WebSockets. */
async function startRemote(
  options: GatewayOptions,
  register: (connection: GatewayConnection, devicePublicKey: string) => void,
): Promise<{ url: string; advertiseUrl: string; close(): Promise<void> } | undefined> {
  const spec = options.secure;
  const remote = spec?.lan;
  if (spec === undefined || remote === undefined) return undefined;
  const http = createServer((request, response) => {
    void serveWebClient(request, response, options.webRoot).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const secure = new WebSocketServer({ server: http });
  secure.on("connection", (socket) => secureHandshake(socket, spec, options.harness, register));
  await new Promise<void>((resolveListen, reject) => {
    http.once("listening", resolveListen);
    http.once("error", reject);
    http.listen(remote.port, "0.0.0.0");
  });
  const { port } = http.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}`;
  const advertiseUrl = remote.publicUrl?.replace(/\/+$/, "") ?? `http://${pickLanAddress(networkInterfaces()) ?? "127.0.0.1"}:${port}`;
  return {
    url,
    advertiseUrl,
    async close() {
      for (const socket of secure.clients) socket.terminate();
      await new Promise<void>((resolve) => secure.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** The conversation list, kept from commit publications rather than polled. */
class ConversationList {
  readonly #listeners = new Set<(list: readonly ConversationSummary[]) => void>();
  #list: readonly ConversationSummary[];
  #unsubscribe: () => void = () => {};
  #notifying = false;

  private constructor(list: readonly ConversationSummary[]) {
    this.#list = list;
  }

  static async open(harness: Harness): Promise<ConversationList> {
    const summaries: ConversationSummary[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
      for (const record of page.items) summaries.push({ ...summaryOf(record), ...(await firstInput(harness, record.id)) });
      cursor = page.next;
    } while (cursor !== undefined);
    const list = new ConversationList(summaries);
    // A commit listener only records; it calls no Session API.
    list.#unsubscribe = harness.subscribeCommits((publication) => {
      let next = list.#list;
      for (const change of publication.changes) {
        if (change.type === "conversation") {
          next = [...next, summaryOf(change.value)];
        } else if (change.type === "entry" && change.value.kind === "pi.user") {
          const id = change.value.conversationId;
          next = next.map((summary) => (summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary));
        }
      }
      if (next !== list.#list) list.#set(next);
    });
    return list;
  }

  get value(): readonly ConversationSummary[] {
    return this.#list;
  }

  subscribe(listener: (list: readonly ConversationSummary[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(list: readonly ConversationSummary[]): void {
    this.#list = list;
    if (this.#notifying) return;
    this.#notifying = true;
    setImmediate(() => {
      this.#notifying = false;
      for (const listener of this.#listeners) listener(this.#list);
    });
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }
}

function summaryOf(record: ConversationRecord): ConversationSummary {
  const parent = record.parent?.conversationId ?? record.owner?.conversationId;
  return {
    id: record.id,
    kind: record.owner !== undefined ? "subagent" : record.parent !== undefined ? "fork" : "conversation",
    ...(parent === undefined ? {} : { parent }),
    // The client's forkable-entry ids are the string form of EntryId.
    ...(record.parent === undefined ? {} : { forkedAt: String(record.parent.at) }),
  };
}

function titleOf(entry: EntryRecord | undefined): { title?: string } {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return {};
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
  return { title: text.replace(/\s+/g, " ").trim() };
}

/**
 * The oldest user message of a conversation, a subagent's task. Unlike upstream, main gets
 * one too: the commit listener titles it live, and a restarted host must list the same.
 * A fork's own first message, not one it inherits, as the listener sees it.
 */
async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
  const conversation = (await harness.conversation(id, context))!;
  let first: EntryRecord | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, context);
    first = page.items.findLast((entry) => entry.kind === "pi.user" && entry.conversationId === id) ?? first;
    cursor = page.next;
  } while (cursor !== undefined);
  return titleOf(first);
}

type Subscription = { stop(): Promise<unknown> | void };
type SubscriptionState = { subscription?: Subscription };
type SendFrame = (frame: ServerFrame) => Promise<void>;

/** What the client is and how the gateway reaches back into its lifecycle. */
interface ClientHooks {
  /** The paired device's X25519 public key; undefined for loopback token clients. */
  readonly devicePublicKey?: string;
  closed(client: GatewayClient): void;
  /** Close every live client of this device — used by `revokeDevice`. */
  closeDevice(publicKey: string): void;
  /** A fresh one-time pairing URL; undefined while remote access is off. */
  createPairing(): { url: string; expiresAt: number } | undefined;
}

class GatewayClient {
  readonly devicePublicKey: string | undefined;
  readonly #connection: GatewayConnection;
  readonly #hooks: ClientHooks;
  readonly #options: GatewayOptions;
  readonly #conversations: ConversationList;
  readonly #subscriptions = new Map<StreamName, SubscriptionState>();
  #disposed = false;

  constructor(connection: GatewayConnection, options: GatewayOptions, conversations: ConversationList, hooks: ClientHooks) {
    this.#connection = connection;
    this.#options = options;
    this.#conversations = conversations;
    this.#hooks = hooks;
    this.devicePublicKey = hooks.devicePublicKey;
    connection.handle({
      message: (text) => {
        let parsed: ReturnType<typeof parseClientFrame>;
        try {
          parsed = parseClientFrame(JSON.parse(text));
        } catch {
          connection.close(INVALID_FRAME_CLOSE_CODE, "Invalid client frame");
          return;
        }
        // ADR-0018 §3: unknown content gets an answer or silence so a newer
        // client keeps its connection; only a malformed frame is a bug.
        switch (parsed.kind) {
          case "frame":
            void this.#receive(parsed.frame).catch(() => connection.close(1011, "Gateway request failed"));
            return;
          case "unsupportedCall":
            void this.send({ type: "result", id: parsed.id, ok: false, error: `Unsupported method: ${parsed.method}` });
            return;
          case "unsupportedStream":
            if (parsed.type === "subscribe") {
              void this.send({ type: "ended", stream: parsed.stream as StreamName, reason: "Unsupported stream" });
            }
            return;
          case "unknownType":
            return;
          case "malformed":
            connection.close(INVALID_FRAME_CLOSE_CODE, "Invalid client frame");
            return;
        }
      },
      closed: () => hooks.closed(this),
    });
    void this.send({
      type: "hello",
      protocol: PROTOCOL,
      ...(packagedVersion === undefined ? {} : { hostVersion: packagedVersion }),
      session: options.session,
      models: options.modelSummaries(),
      defaults: options.defaults,
      docs: (options.docs ?? []).map((doc) => ({
        kind: doc.token.definition.kind,
        ...(doc.presentation === undefined ? {} : { presentation: doc.presentation }),
      })),
      toolPresentations: options.toolPresentations ?? {},
    });
  }

  /** Resolves once the frame is handed to the transport, so a watch callback holds its next frame until then. */
  send(frame: ServerFrame): Promise<void> {
    if (!this.#connection.open) return Promise.resolve();
    return this.#connection.send(JSON.stringify(frame));
  }

  closeConnection(code: number, reason: string): void {
    this.#connection.close(code, reason);
  }

  async #receive(frame: ClientFrame): Promise<void> {
    if (frame.type === "subscribe") await this.#subscribe(frame.stream);
    else if (frame.type === "unsubscribe") await this.#unsubscribe(frame.stream);
    else await this.#answer(frame.id, frame.method, frame.args);
  }

  async #subscribe(stream: StreamName): Promise<void> {
    const previous = this.#subscriptions.get(stream);
    const state: SubscriptionState = {};
    this.#subscriptions.set(stream, state);
    const current = () => !this.#disposed && this.#subscriptions.get(stream) === state;
    const send: SendFrame = (frame) => (current() ? this.send(frame) : Promise.resolve());
    let subscription: Subscription;
    try {
      await previous?.subscription?.stop();
      if (!current()) return;
      subscription = await this.#open(stream, send);
    } catch (error) {
      if (current()) {
        await send({ type: "ended", stream, reason: error instanceof Error ? error.message : String(error) });
        if (current()) this.#subscriptions.delete(stream);
      }
      return;
    }
    // An obsolete watch can finish acquiring after its replacement has already opened.
    if (!current()) {
      await subscription.stop();
      return;
    }
    state.subscription = subscription;
  }

  async #open(stream: StreamName, send: SendFrame): Promise<Subscription> {
    if (stream === "conversations") {
      void send({ type: "snapshot", stream, value: this.#conversations.value });
      const unsubscribe = this.#conversations.subscribe((value) => void send({ type: "snapshot", stream, value }));
      return { stop: unsubscribe };
    }
    if (stream === "index") {
      const watch = await this.#options.harness.watchDoc(IndexDoc, context);
      if (watch === undefined) throw new Error("Index document is missing");
      return this.#forward(stream, watch, send);
    }
    if (stream === "devices") {
      const watch = await this.#options.harness.watchDoc(DevicesDoc, context);
      if (watch === undefined) throw new Error("Devices document is missing");
      return this.#forward(stream, watch, send);
    }
    if (stream === "tasks") return this.#forward(stream, await this.#options.harness.watchTaskGraph(context), send);
    if (stream === "mcp") {
      await send({ type: "snapshot", stream, value: this.#options.mcp?.value ?? null });
      const mcp = this.#options.mcp;
      return mcp === undefined ? { stop: () => {} } : { stop: mcp.subscribe((value) => void send({ type: "snapshot", stream, value })) };
    }
    if (stream.startsWith("doc:")) {
      const at = stream.lastIndexOf(":");
      return this.#openDoc(stream, stream.slice("doc:".length, at), Number(stream.slice(at + 1)) as ConversationId, send);
    }
    const conversation = await this.#conversation(Number(stream.slice("conversation:".length)) as ConversationId);
    return this.#forward(stream, await conversation.watch(context), send);
  }

  /** A document that does not exist yet streams `null`, then its value from the commit that creates it. */
  async #openDoc(stream: StreamName, kind: string, id: ConversationId, send: SendFrame): Promise<Subscription> {
    const doc = this.#options.docs?.find((candidate) => candidate.token.definition.kind === kind);
    if (doc === undefined) throw new Error(`Unknown document ${kind}`);
    const token = doc.token;
    await this.#conversation(id);
    const { harness } = this.#options;
    let signalCreation!: () => void;
    const created = new Promise<void>((resolve) => {
      signalCreation = resolve;
    });
    let inner: Subscription | undefined;
    let stopped = false;
    // Observe creation before probing absence, so a commit cannot fall between the two.
    const unsubscribe = harness.subscribeCommits((publication) => {
      const matches = publication.changes.some(
        (change) => (change.type === "document" || change.type === "document.copy") && change.record.kind === kind && change.conversationId === id,
      );
      if (!matches) return;
      unsubscribe();
      // A commit listener must not call Session APIs; attach after it returns.
      setImmediate(() => signalCreation());
    });
    try {
      const existing = await harness.watchDoc(token, id, context);
      if (existing !== undefined) {
        unsubscribe();
        return this.#forward(stream, existing, send);
      }
      await send({ type: "snapshot", stream, value: null });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    void created
      .then(async () => {
        if (stopped) return;
        const watch = await harness.watchDoc(token, id, context);
        if (watch === undefined) return;
        if (stopped) await watch.stop();
        else {
          inner = await this.#forward(stream, watch, send);
          if (stopped) await inner.stop();
        }
      })
      .catch((error: unknown) => {
        unsubscribe();
        return send({ type: "ended", stream, reason: error instanceof Error ? error.message : String(error) });
      });
    return {
      stop: async () => {
        stopped = true;
        unsubscribe();
        signalCreation();
        await inner?.stop();
      },
    };
  }

  async #forward<T>(stream: StreamName, watch: WatchHandle<T>, send: SendFrame): Promise<Subscription> {
    await send({ type: "snapshot", stream, value: watch.value });
    watch.start((_value, ops) => send({ type: "ops", stream, ops }));
    return watch;
  }

  async #unsubscribe(stream: StreamName): Promise<void> {
    const subscription = this.#subscriptions.get(stream);
    this.#subscriptions.delete(stream);
    await subscription?.subscription?.stop();
  }

  async #conversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#options.harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
    return conversation;
  }

  async #answer(id: number, method: CallMethod, args: CallMethods[CallMethod]["args"]): Promise<void> {
    try {
      const value = await this.#call(method, args);
      await this.send({ type: "result", id, ok: true, value: value ?? null });
    } catch (error) {
      await this.send({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #call(method: CallMethod, args: CallMethods[CallMethod]["args"]): Promise<unknown> {
    switch (method) {
      case "addProject":
        return addProject(this.#options.harness, (args as CallMethods["addProject"]["args"]).path, context);
      case "removeProject":
        await removeProject(this.#options.harness, (args as CallMethods["removeProject"]["args"]).path, context);
        return null;
      case "createConversation": {
        const create = args as CallMethods["createConversation"]["args"];
        const conversationId = await createConversation(
          this.#options.harness,
          this.#options.dataDir,
          {
            home: create.home,
            text: create.text,
            requestId: create.requestId,
            ...(create.checkout === undefined ? {} : { checkout: create.checkout }),
            ...(create.model === undefined ? {} : { model: create.model }),
            ...(create.thinkingLevel === undefined ? {} : { thinkingLevel: create.thinkingLevel }),
          },
          this.#options.defaults,
          this.#options.models,
          context,
        );
        return { conversationId };
      }
      case "archive": {
        const input = args as CallMethods["archive"]["args"];
        await archive(this.#options.harness, input.conversationId, input.archived, context);
        // Archiving cleans worktree directories of the subtree but keeps
        // branches — they may hold unmerged work (ADR-0010 §7).
        if (input.archived) {
          const kept = await cleanupArchivedWorktrees(this.#options.harness, input.conversationId, context);
          for (const { record, reason } of kept) {
            await this.send({ type: "notice", level: "warning", message: `Kept worktree ${record.path} (branch ${record.branch}): ${reason}` });
          }
        }
        return null;
      }
      case "createPairing": {
        const pairing = this.#hooks.createPairing();
        if (pairing === undefined) throw new Error("Remote access is off; start the host with --remote-port or --relay");
        return pairing;
      }
      case "revokeDevice": {
        const { publicKey } = args as CallMethods["revokeDevice"]["args"];
        await revokeDevice(this.#options.harness, publicKey, context);
        this.#hooks.closeDevice(publicKey);
        return null;
      }
    }
    const conversation = await this.#conversation((args as { conversationId: ConversationId }).conversationId);
    switch (method) {
      case "submit": {
        const { text, whenBusy, requestId } = args as CallMethods["submit"]["args"];
        // A pending question never blocks the composer (ADR-0011 §4): mark it
        // dismissed so its wait task finishes, then steer regardless.
        const dismissed = await this.#dismissPendingQuestions(conversation.id, context);
        const submission = await conversation.submit(
          { type: "input", content: text, whenBusy: dismissed ? "steer" : whenBusy, requestId },
          context,
        );
        void submission.wait(context).then(
          (settled) => {
            if (settled.status === "unanswered" && settled.reason !== "aborted") {
              void this.send({ type: "notice", level: "error", message: `No answer: ${settled.reason}` });
            }
          },
          () => {},
        );
        return { submissionId: submission.id };
      }
      case "abort":
        await conversation.abort(context);
        return null;
      case "compact": {
        const { instructions } = args as CallMethods["compact"]["args"];
        const taskId = await conversation.compact(instructions, context);
        void this.#options.harness.waitForTask(taskId, context).then(
          (receipt) => void this.send({ type: "notice", level: "info", message: `Compaction ${receipt.state.outcome.status}.` }),
          () => {},
        );
        return { taskId };
      }
      case "setModel": {
        const { model: ref } = args as CallMethods["setModel"]["args"];
        const model = this.#options.models.getModel(ref.provider, ref.modelId);
        if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
        const thinking: ModelThinkingLevel = (await this.#agent(conversation.id)).thinkingLevel ?? "off";
        await conversation.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
        return null;
      }
      case "setThinkingLevel": {
        const { level } = args as CallMethods["setThinkingLevel"]["args"];
        const agent = await this.#agent(conversation.id);
        const model = agent.model === undefined ? undefined : this.#options.models.getModel(agent.model.provider, agent.model.modelId);
        if (model === undefined) throw new Error("No model selected");
        if (!getSupportedThinkingLevels(model).includes(level)) {
          throw new Error(`Thinking level ${level} is not supported by ${agent.model!.provider}/${agent.model!.modelId}`);
        }
        await conversation.configure({ thinkingLevel: level }, context);
        return null;
      }
      case "fork": {
        const { entryId, removeTools = [] } = args as CallMethods["fork"]["args"];
        // ADR-0019: fork calls serialize — the checks below must observe every
        // landed fork, across every connected client.
        return await serializedFork(this.#options.harness, async () => {
          const at = Number(entryId) as EntryId;
          // Read the records inside a fresh commit: they are guaranteed current,
          // unlike the publication-fed ConversationList a resolved fork only
          // updates asynchronously.
          await this.#options.harness.commit(async (tx) => {
            const record = await tx.conversation(conversation.id);
            if (record === undefined) throw new Error(`Conversation ${conversation.id} does not exist`);
            if (record.parent !== undefined || record.owner !== undefined) {
              throw new Error("Only top-level conversations can be forked");
            }
            let cursor: Cursor | undefined;
            do {
              const page = await tx.scanConversations({}, 256, cursor);
              for (const candidate of page.items) {
                if (candidate.parent?.conversationId === conversation.id && candidate.parent.at === at) {
                  throw new Error("This message already has a fork");
                }
              }
              cursor = page.next;
            } while (cursor !== undefined);
          }, context);
          // Tools are stored by name; the fork's agent drops these from what its parent offered.
          const agent = await conversation.agent(context);
          const remove = agent.tools.filter((tool) => removeTools.includes(tool.name));
          // No init: the fork inherits the parent's agent — same cwd, the same
          // execution checkout (ADR-0019 §1).
          const fork = await conversation.fork(
            at,
            {
              ownership: { kind: "ownerless" },
              ...(remove.length === 0 ? {} : { agent: { tools: { remove } } }),
            },
            context,
          );
          return { conversationId: fork.id };
        });
      }
      case "answer": {
        const { kind, requestId, answers } = args as CallMethods["answer"]["args"];
        // A PiNomad-owned interaction: core applies the client's answers against
        // the pinomad.question presentation schema, not extension code.
        const doc = this.#options.docs?.find(
          (candidate) => candidate.token.definition.kind === kind && candidate.presentation === "pinomad.question",
        );
        if (doc === undefined) throw new Error(`Document ${kind} does not accept answers`);
        const token = doc.token;
        return await this.#options.harness.commit(async (tx) => {
          const value = await tx.doc(token, conversation.id);
          if (!Value.Check(QuestionSchema, value)) throw new Error(`Document ${kind} does not hold question requests`);
          const request = value.requests.find((candidate) => candidate.id === requestId);
          if (request === undefined) throw new Error(`Unknown question request ${requestId}`);
          if (request.resolution !== undefined) return { first: false };
          if (answers.length !== request.questions.length) {
            throw new Error(`Expected ${request.questions.length} answers, got ${answers.length}`);
          }
          for (let i = 0; i < request.questions.length; i++) {
            const question = request.questions[i]!;
            const answer = answers[i]!;
            const labels = new Set(question.options.map((option) => option.label));
            for (const label of answer.selected) {
              if (!labels.has(label)) throw new Error(`Unknown option for "${question.header}": ${label}`);
            }
            if (question.multiSelect !== true && answer.selected.length > 1) {
              throw new Error(`"${question.header}" accepts a single option`);
            }
          }
          request.resolution = { outcome: "answered", answers, at: Date.now() };
          return { first: true };
        }, context);
      }
      case "changes": {
        return await this.#changes(conversation, context);
      }
    }
  }

  /**
   * Mark every unresolved `pinomad.question` request of a conversation
   * dismissed — the user chose to reply in chat instead (ADR-0011 §4). The wait
   * task sees the doc change and ends the tool. True when any were dismissed.
   */
  async #dismissPendingQuestions(conversationId: ConversationId, context: Context): Promise<boolean> {
    const questionDocs = (this.#options.docs ?? []).filter((doc) => doc.presentation === "pinomad.question");
    // Snapshot first: submits happen on every message, so committing blindly
    // would write on every send and materialize an empty doc per conversation.
    const snapshots = await Promise.all(questionDocs.map((doc) => this.#options.harness.snapshot(doc.token, conversationId, context)));
    const pending = snapshots.some(
      (value) => Value.Check(QuestionSchema, value) && value.requests.some((request) => request.resolution === undefined),
    );
    if (!pending) return false;
    return await this.#options.harness.commit(async (tx) => {
      let dismissed = false;
      for (const doc of questionDocs) {
        const value = await tx.doc(doc.token, conversationId);
        if (!Value.Check(QuestionSchema, value)) continue;
        // Re-check inside the commit: a client answer may have landed meanwhile.
        for (const request of value.requests) {
          if (request.resolution === undefined) {
            request.resolution = { outcome: "dismissed", at: Date.now() };
            dismissed = true;
          }
        }
      }
      return dismissed;
    }, context);
  }

  /**
   * The conversation's file changes (ADR-0010 context): a worktree diff vs its
   * recorded base, else a project dir's uncommitted diff vs HEAD.
   */
  /** Chat checkouts live in the data dir — never treated as a user repo. */
  get #chatsPrefix(): string {
    return join(this.#options.dataDir, "chats") + sep;
  }

  async #changes(conversation: Conversation, context: Context) {
    const cwd = (await conversation.agent(context)).cwd;
    if (cwd === undefined) return { available: false as const, reason: "No working directory" };
    // A chat dir could sit inside a repo (when the data dir does) — it is never a project checkout.
    if (cwd.startsWith(this.#chatsPrefix)) return { available: false as const, reason: "Chat conversations have no repository" };
    const index = await this.#options.harness.snapshot(IndexDoc, context);
    const record = checkoutAt(index?.checkouts, cwd);
    if (record !== undefined) {
      if (!(await worktreeExists(record.path))) return { available: false as const, reason: "No changes yet" };
      return { available: true as const, ...(await changesOf(record.path, record.base)) };
    }
    const base = await gitBase(cwd);
    if (base === undefined) return { available: false as const, reason: "Not in a git repository" };
    return { available: true as const, ...(await changesOf(base.repo, base.base)) };
  }

  async #agent(id: ConversationId): Promise<Readonly<AgentState>> {
    return (await this.#options.harness.snapshot(AgentDoc, id, context)) ?? {};
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const state of subscriptions) await state.subscription?.stop();
  }
}
