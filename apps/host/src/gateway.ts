import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join, sep } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type CommitPublication,
  type Conversation,
  type ConversationDocToken,
  type ConversationId,
  type ConversationRecord,
  configure,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  InboxDoc,
  type JsonObject,
  LiveDoc,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
  type LiveState,
  type ToolSlot,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { WebSocket, WebSocketServer } from "ws";
import { Value } from "typebox/value";
import { QuestionSchema, type PresentationType } from "@pinomad/protocol/presentation.ts";
import {
  type CallMethod,
  type CallMethods,
  type ClientFrame,
  type HostStreamName,
  type HostStreamValues,
  parseClientFrame,
  INVALID_FRAME_CLOSE_CODE,
  PROTOCOL,
  type ServerFrame,
  type StreamName,
  UNAUTHORIZED_CLOSE_CODE,
} from "@pinomad/protocol/frames.ts";
import type { HostAuth, HostProviders } from "@pinomad/protocol/auth.ts";
import type { McpStatus } from "@pinomad/protocol/mcp.ts";
import type { DeviceEntry } from "@pinomad/protocol/devices.ts";
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
import { branchOf, changesOf, checkoutAt, gitBase, worktreeExists } from "./checkout.ts";
import { packagedVersion } from "./distribution.ts";
import { listFolders } from "./folders.ts";
import { createCandidateLister, enumerateRoot, listFiles, type FileLister } from "./files.ts";
import { expandSkills, mentionedSkillNames } from "./skill-expansion.ts";
import { stripUserBlocks } from "@pinomad/client/skill-blocks.ts";
import { createSkillLister, enumerateSkills, listSkills, scopeSkills, type ListedSkill, type SkillLister } from "./skills.ts";
import { listCommands, runCommand } from "./commands.ts";
import { constantValue, type HostValue } from "./host-value.ts";
import { imageProblem, type MessageImage, type OutgoingImage } from "@pinomad/protocol/images.ts";
import { attachmentBlock } from "@pinomad/protocol/attachments.ts";
import type { AttachmentStore } from "./attachments.ts";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { ImageRefs } from "./image-refs.ts";
import { ImageVariants } from "./image-variants.ts";
import type { AgentRoleStore } from "./agent-roles.ts";
import type { AgentRoles } from "@pinomad/protocol/agents.ts";
import { type HostSettingsStore, settingsDefaults } from "./host-settings.ts";
import { messageContent } from "./message-content.ts";
import type { ModelAuth } from "./model-auth.ts";
import { RoleDoc } from "./role-doc.ts";
import { SubagentDoc } from "./subagent-doc.ts";
import { attachAutoTitle } from "./auto-title.ts";
import { TitleDoc } from "./title-doc.ts";
import { admitDevice, DevicesDoc, type PairingOffers } from "./devices.ts";
import { normalizeOrigin, readServerBinding, readServerConfig } from "./server-config.ts";
import { attachPushSender, revokeDevice, setPushToken, type PushTimers, type PushTransport } from "./push.ts";
import { toolTarget } from "@pinomad/protocol/tool-target.ts";
import { type RelayLink, relayWsBase, startRelayLink } from "./relay-link.ts";
import { serveWebClient } from "./web-client.ts";
import {
  addProject,
  archive,
  cleanupArchivedWorktrees,
  createConversation,
  IndexDoc,
  removeProject,
  setAgent,
} from "./organization.ts";
import type { HostIndex, SkillScope } from "@pinomad/protocol/organization.ts";

const context: Context = BACKGROUND_CONTEXT;

/**
 * Fork calls on one host serialize here (ADR-0019 §3): the one-fork-per-message
 * check reads records inside a fresh commit, which is only safe if no second
 * fork can land between the check and the create.
 */
const forkTails = new WeakMap<Harness, Promise<unknown>>();

/**
 * `Tx.submission` is the transaction's committed-submission read; upstream
 * types it only on `Session` because it is internal, but commits use it for
 * exactly this purpose (the inbox boundary does). Keeping the read in the
 * commit is what makes steerQueued's validation and mode change atomic.
 */
type SubmissionReadTx = Tx & { submission(id: SubmissionId): Promise<SubmissionRecord | undefined> };

/**
 * Refuse a submission that is not this conversation's user input: a write
 * has no content, and promoting or withdrawing it would corrupt reset
 * semantics. Throws so the gateway answers `ok:false`.
 */
function assertQueuedInput(record: SubmissionRecord, conversationId: ConversationId): void {
  if (record.conversationId !== conversationId) {
    throw new Error(`Submission ${record.id} belongs to another conversation`);
  }
  if (record.type !== "input") throw new Error(`Submission ${record.id} is a write, not a message`);
}

/**
 * Mark every unresolved `pinomad.question` request in `docs` dismissed — the
 * user chose to reply in chat instead (ADR-0011 §4). The wait task sees the
 * doc change and ends the tool. Shared by submit's standalone commit and
 * steerQueued's combined one; both re-check inside the commit because a
 * client answer may have landed meanwhile.
 */
async function dismissPendingQuestions(
  tx: Tx,
  docs: readonly ExtensionDoc[],
  conversationId: ConversationId,
): Promise<boolean> {
  let dismissed = false;
  for (const doc of docs) {
    const value = await tx.doc(doc.token, conversationId);
    if (!Value.Check(QuestionSchema, value)) continue;
    for (const request of value.requests) {
      if (request.resolution === undefined) {
        request.resolution = { outcome: "dismissed", at: Date.now() };
        dismissed = true;
      }
    }
  }
  return dismissed;
}

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
  /** Optional processor for on-demand image variants; absent returns original. */
  readonly images?: ImageProcessor;
  readonly session: SessionInfo;
  readonly token: string;
  readonly port: number;
  /** Exact browser origins permitted to connect. Native clients send no Origin. */
  readonly browserOrigins?: readonly string[];
  /** Chat checkouts live under `<dataDir>/chats`. */
  readonly dataDir: string;
  /** Host-stored file uploads (issue #321); absent → the new calls fail. */
  readonly attachments?: AttachmentStore;
  /** The user-skills entry (`<agentsHome>/skills`) — the same dir the context extension's prompts read (ADR-0006). */
  readonly agentsHome: string;
  /** Host settings store (ADR-0021): backs the `settings` stream, `hello.defaults`, `updateSettings`, and new-conversation defaults. */
  readonly settings: HostSettingsStore;
  /** Named-agent store (ADR-0023): backs the `agents` stream and the create/update/delete calls. */
  readonly agents?: AgentRoleStore;
  /** MCP server status source; absent → the `mcp` stream snapshots `null` (ADR-0012 §8). */
  readonly mcp?: HostValue<McpStatus>;
  /**
   * Live `models`/`auth`/`providers` sources and the provider calls (ADR-0031).
   * Absent (faux mode, tests) → `models` snapshots `modelSummaries()` once,
   * `auth` and `providers` snapshot empty lists, and the calls fail.
   */
  readonly modelAuth?: Omit<ModelAuth, "close">;
  /** Conversation documents offered as `doc:<kind>:<conversationId>` streams. */
  readonly docs?: readonly ExtensionDoc[];
  /** Tool name → presentation of its result `details`, announced in the hello. */
  readonly toolPresentations?: Record<string, PresentationType>;
  /** Built web client served over plain HTTP on both listeners; absent → 503. */
  readonly webRoot?: string;
  /** Name conversations after their first successful run; default on. */
  readonly autoTitle?: boolean;
  /**
   * APNs push sender (ADR-0025): absent → `setPushToken` still registers but
   * nothing leaves the host; tests inject `transport`/`timers` fakes, the real
   * wiring uses the relay link as the transport.
   */
  readonly push?: {
    /** The host's X25519 public key, base64url — the push payload's `data.hostKey`. */
    readonly hostKey: string;
    readonly transport?: PushTransport;
    readonly timers?: PushTimers;
  };
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
  const conversations = await ConversationList.open(options.harness, options.docs);
  // One lister for the gateway: all clients' `listFiles` share its cache and
  // its concurrency bound (issue #138 §成本控制).
  const fileLister = createCandidateLister(enumerateRoot);
  // Same for `listSkills` — concurrent clients' scope queries ride one scan
  // (issue #143). The skills dirs it reads are the prompt's own.
  const skillLister = createSkillLister((root, mode) => enumerateSkills(root, mode, options.agentsHome));
  const imageVariants = new ImageVariants(options.images);
  const detachAutoTitle =
    options.autoTitle === false
      ? undefined
      : attachAutoTitle(conversations, {
          harness: options.harness,
          models: options.models,
          settings: options.settings,
        });
  // The loopback port also serves the built web client: in service mode there
  // is no vite dev server to reach it through (ADR-0009 §7).
  const http = createServer((request, response) => {
    void serveWebClient(request, response, options.webRoot).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1");
  });
  // Attached only once listening: ws re-emits the http server's errors on
  // itself, so a listen error (a taken port) would throw unhandled there and
  // never reach the reject above.
  const server = new WebSocketServer({ server: http });
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
  const register = (connection: GatewayConnection, devicePublicKey?: string, joined?: DeviceEntry): void => {
    // A server-vouched device announces itself to every client already online
    // (ADR-0022 §6); broadcast before the newcomer joins `clients` — the
    // notice would only tell it about itself.
    if (joined?.source === "account") {
      broadcast("info", `New device "${joined.name}" joined through your account`);
    }
    const client = new GatewayClient(connection, options, conversations, fileLister, skillLister, imageVariants, {
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
        const pair = (secret: string) => `pair=${toBase64Url(spec.hostKey.publicKey)}.${secret}`;
        // The offer's source is the link it rides on: a reachable URL is a
        // "qr" offer; a loopback-only one is "local" (ADR-0020 §4, ADR-0022 §6).
        // The relay wins: a link through it works from any network, while the
        // LAN URL only reaches devices that can already see the host.
        if (relay !== undefined) {
          const { secret, expiresAt } = spec.offers.create("qr");
          const target = `${relayWsBase(relay.origin)}/c/${relay.hostId}`;
          return { url: `${relay.origin}/#${pair(secret)}&url=${encodeURIComponent(target)}`, expiresAt };
        }
        if (remote !== undefined) {
          const { secret, expiresAt } = spec.offers.create("qr");
          return { url: `${remote.advertiseUrl}/#${pair(secret)}`, expiresAt };
        }
        const { secret, expiresAt } = spec.offers.create("local");
        const target = `ws://127.0.0.1:${port}${LOOPBACK_SECURE_PATH}`;
        return { url: `http://127.0.0.1:${port}/#${pair(secret)}&url=${encodeURIComponent(target)}`, expiresAt };
      },
    });
    clients.add(client);
  };
  /**
   * The live reads `admitDevice` performs inside its commit (ADR-0022 §6):
   * settings are in-memory, but server.json can be rewritten mid-run by
   * join/leave (the restart comes later) — so the binding is re-read at
   * admission, and an offer minted under a binding that no longer stands
   * refuses. The binding is a fresh random value per server.json write:
   * re-joining the same origin still retires earlier offers.
   */
  const admission = {
    harness: options.harness,
    acceptAccountDevices: () => options.settings.value.acceptAccountDevices,
    serverBinding: async (): Promise<string | undefined> =>
      await readServerBinding(options.dataDir).catch(() => undefined),
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
      secureHandshake(socket, secure, admission, register);
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

  remote = await startRemote(options, admission, register).catch(async (error: unknown) => {
    // Startup fails, so nobody will call close(): free the loopback port here.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw error;
  });
  const secure = options.secure;
  // Flipping the account switch off kills account offers still in flight —
  // they were minted under a grant that no longer stands (ADR-0022 §6).
  const detachSettingsWatch = options.settings.subscribe((settings) => {
    if (!settings.acceptAccountDevices) secure?.offers.revokeAccount();
  });
  if (secure?.relay !== undefined) {
    const relayOrigin = secure.relay.origin;
    // `link` is assigned before any state change can fire — transitions only
    // ever happen from async socket events.
    let link!: RelayLink;
    link = startRelayLink({
      origin: relayOrigin,
      signingKey: secure.relay.signingKey,
      noisePublicKey: secure.hostKey.publicKey,
      accept: (socket) => secureHandshake(socket, secure, admission, register),
      // The name the control connection reports and keeps in sync (issue
      // #212): the settings stream's effective hostName. The shared type
      // marks it optional — absent only when describing pre-5.12 hosts —
      // so the link treats undefined as "don't report".
      hostName: {
        get value() {
          return options.settings.value.hostName;
        },
        subscribe: (listener) => options.settings.subscribe((settings) => listener(settings.hostName)),
      },
      // ADR-0022 §4: the server vouches for a device by asking for an offer
      // over this control connection. These are early answers only — the real
      // admission check runs again inside admitDevice's commit, so refusal
      // reasons here are for the client's message, not enforcement.
      accountOffer: async () => {
        if (!options.settings.value.acceptAccountDevices) return { ok: false, reason: "disabled" };
        const config = await readServerConfig(options.dataDir).catch(() => undefined);
        if (config?.binding === undefined) return { ok: false, reason: "not_joined" };
        // A re-join rewrites server.json before the host restarts: this link
        // still belongs to the previous server, and minting under the new
        // binding would hand it invites the admission check would honor.
        if (normalizeOrigin(config.origin) !== normalizeOrigin(relayOrigin)) {
          return { ok: false, reason: "rebinding" };
        }
        const { secret, expiresAt } = secure.offers.createAccount(config.binding);
        return { ok: true, secret, expiresAt };
      },
      onStateChange: (state) => {
        // stdout JSON lines in the same style as main.ts's `ready` event, so
        // journalctl shows whether the host is registered with its relay.
        if (state.status === "registered") {
          // The push declaration is part of the registration: "undeclared"
          // means a pre-push server or an unbound host, [] means no APNs keys.
          const push = state.push === undefined ? "undeclared" : state.push.length === 0 ? "none" : state.push.join(",");
          console.log(JSON.stringify({ event: "relay", status: "registered", origin: link.origin, hostId: link.hostId, push }));
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
  // Attached after the link exists: its pushes ride the control connection,
  // so the link is the sender's transport (ADR-0025 §3). Tests inject a fake.
  const detachPush =
    options.push === undefined
      ? undefined
      : await attachPushSender({
          harness: options.harness,
          conversations,
          hostKey: options.push.hostKey,
          ...(options.push.transport === undefined
            ? relay === undefined
              ? {}
              : { transport: { send: (request) => relay.sendPush(request) } }
            : { transport: options.push.transport }),
          ...(options.push.timers === undefined ? {} : { timers: options.push.timers }),
        });
  return {
    url: `ws://127.0.0.1:${port}`,
    ...(remote === undefined ? {} : { remote: { url: remote.url, advertiseUrl: remote.advertiseUrl } }),
    ...(relay === undefined ? {} : { relay }),
    broadcast,
    async close() {
      await relay?.close();
      detachAutoTitle?.();
      detachSettingsWatch();
      await detachPush?.close();
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
 * Everything `admitDevice` needs beyond the socket: the store, and the reads
 * it performs inside its one commit so a revoked key, a flipped switch, or a
 * rewritten server.json cannot slip between check and write (ADR-0022 §6).
 */
interface AdmissionPolicy {
  readonly harness: Harness;
  readonly acceptAccountDevices: () => boolean;
  readonly serverBinding: () => Promise<string | undefined>;
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
  policy: AdmissionPolicy,
  register: (connection: GatewayConnection, devicePublicKey: string, joined?: DeviceEntry) => void,
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
        register(secureConnection(socket, session), admitted.deviceKey, admitted.joined);
      })
      .catch(() => socket.close(1011, "handshake failed"));
    async function admit(): Promise<
      { result: HandshakeResult; message: Uint8Array; deviceKey: string; joined?: DeviceEntry } | undefined
    > {
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
      const decision = await admitDevice(
        policy.harness,
        {
          publicKey: deviceKey,
          ...(hello.pair === undefined ? {} : { pair: hello.pair }),
          offers: secure.offers,
          acceptAccountDevices: policy.acceptAccountDevices,
          serverBinding: policy.serverBinding,
        },
        context,
      );
      // A registered device with `pair` present still passes — a retry after a
      // lost message 2 must not spend another offer.
      if (decision.outcome === "refused") {
        socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
        return undefined;
      }
      const { message, result } = responder.writeMessage2(encodeHostHello({ v: 1 }));
      return {
        result,
        message,
        deviceKey,
        ...(decision.outcome === "admitted" ? { joined: decision.entry } : {}),
      };
    }
  });
}

/** The 0.0.0.0 listener: plain HTTP for the web client + secure WebSockets. */
async function startRemote(
  options: GatewayOptions,
  admission: AdmissionPolicy,
  register: (connection: GatewayConnection, devicePublicKey: string, joined?: DeviceEntry) => void,
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
  await new Promise<void>((resolveListen, reject) => {
    http.once("listening", resolveListen);
    http.once("error", reject);
    http.listen(remote.port, "0.0.0.0");
  });
  // After listen, as on the loopback port: a listen error must reach reject.
  const secure = new WebSocketServer({ server: http });
  secure.on("connection", (socket) => secureHandshake(socket, spec, admission, register));
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
class ConversationList implements HostValue<readonly ConversationSummary[]> {
  readonly #listeners = new Set<(list: readonly ConversationSummary[]) => void>();
  /** Conversation-doc tokens carrying pinomad.question requests; supplied by the composition root, not hardcoded. */
  readonly #questionTokens: readonly ConversationDocToken<JsonObject>[];
  readonly #questionKinds: ReadonlySet<string>;
  readonly #records = new Map<ConversationId, ConversationRecord>();
  readonly #facts = new Map<ConversationId, ConversationFacts>();
  /** Top-level conversation id → its index entry's `role` (ADR-0023): the only source a summary's role derives from. */
  #roles = new Map<ConversationId, string>();
  /** Slot of each summary in #list; in-place updates keep positions stable. */
  readonly #index = new Map<ConversationId, number>();
  /** Run-end listeners (auto-title); they fire inside the commit listener. */
  readonly #runEnd = new Set<(id: ConversationId) => void>();
  #list: readonly ConversationSummary[] = [];
  #unsubscribe: () => void = () => {};
  #notifying = false;

  private constructor(docs: readonly ExtensionDoc[] | undefined) {
    this.#questionTokens = (docs ?? []).filter((doc) => doc.presentation === "pinomad.question").map((doc) => doc.token);
    this.#questionKinds = new Set(this.#questionTokens.map((token) => token.definition.kind));
  }

  static async open(harness: Harness, docs: readonly ExtensionDoc[] | undefined): Promise<ConversationList> {
    const list = new ConversationList(docs);
    const summaries: ConversationSummary[] = [];
    let cursor: Cursor | undefined;
    const records: ConversationRecord[] = [];
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
      for (const record of page.items) {
        list.#records.set(record.id, record);
        list.#facts.set(record.id, await list.#load(harness, record));
        records.push(record);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    // Roles resolve after the scan: a fork may arrive before its top-level
    // ancestor in scan order, so the whole map is read before deriving.
    list.#roles = rolesOf(await harness.snapshot(IndexDoc, context));
    for (const record of records) {
      list.#index.set(record.id, summaries.length);
      summaries.push(list.#summaryOf(record));
    }
    list.#list = summaries;
    // A commit listener only records; it calls no Session API.
    list.#unsubscribe = harness.subscribeCommits((publication) => list.#observe(publication));
    // A commit between the index snapshot and the subscription is applied to
    // the store but reaches no listener — re-read and re-derive what moved.
    const touched = new Set<ConversationId>();
    list.#reindex(await harness.snapshot(IndexDoc, context), touched);
    list.#refreshSummaries(touched);
    return list;
  }

  /** Startup facts for one record: entry history plus non-creating doc snapshots. */
  async #load(harness: Harness, record: ConversationRecord): Promise<ConversationFacts> {
    const history = await historyFacts(harness, record.id);
    const facts: ConversationFacts = { pending: new Set(), ...history };
    const live = await harness.snapshot(LiveDoc, record.id, context);
    facts.running = live?.run !== undefined;
    facts.tools = live?.tools;
    for (const token of this.#questionTokens) {
      const value = await harness.snapshot(token, record.id, context);
      if (Value.Check(QuestionSchema, value) && value.requests.some((request) => request.resolution === undefined)) {
        facts.pending.add(token.definition.kind);
      }
    }
    if (record.owner !== undefined) {
      const subagent = await harness.snapshot(SubagentDoc, record.id, context);
      if (typeof subagent?.label === "string" && subagent.label !== "") facts.label = subagent.label;
      if (typeof subagent?.role === "string" && subagent.role !== "") facts.role = subagent.role;
    }
    // Absent is meaningful: a conversation created before RoleDoc existed
    // falls back to the index entry; an explicit null is "no agent".
    facts.agent = roleNameOf(await harness.snapshot(RoleDoc, record.id, context));
    const named = (await harness.snapshot(TitleDoc, record.id, context))?.title;
    if (typeof named === "string" && named !== "") facts.named = named;
    return facts;
  }

  #observe(publication: CommitPublication): void {
    const touched = new Set<ConversationId>();
    // Conversations whose run ended in this commit (pi.live cleared `run`).
    const ended = new Set<ConversationId>();
    // Records first: a doc change and the record for a new subagent land in one
    // publication, whose change order is unspecified.
    for (const change of publication.changes) {
      if (change.type === "conversation") {
        this.#records.set(change.value.id, change.value);
        touched.add(change.value.id);
      }
    }
    for (const change of publication.changes) {
      if (change.type === "entry") {
        const entry = change.value;
        if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
        const facts = this.#fact(entry.conversationId);
        if (entry.kind === "pi.user" && facts.title === undefined) Object.assign(facts, titleOf(entry));
        // Entries only append: the largest id is the newest own message, whatever
        // order this publication lists it in.
        if (facts.newest !== undefined && entry.id <= facts.newest) continue;
        touched.add(entry.conversationId);
        facts.newest = entry.id;
        const message = entry.model?.[0];
        // Same rule as the startup scan: updatedAt is the newest entry's
        // timestamp or nothing — never a stale earlier message's.
        facts.updatedAt = typeof message?.timestamp === "number" ? message.timestamp : undefined;
        facts.failed = entry.kind === "pi.assistant" && message?.role === "assistant" && message.stopReason === "error";
        facts.calls = entry.kind === "pi.assistant" ? callsOf(message) : undefined;
      } else if (change.type === "document") {
        const id = change.conversationId;
        if (id === undefined) {
          // The session-scoped index carries each top-level conversation's
          // `role` — a write re-derives every summary that resolves to it.
          if (change.record.kind === IndexDoc.definition.kind) this.#reindex(change.value as HostIndex | null, touched);
          continue;
        }
        const facts = this.#fact(id);
        if (change.record.kind === "pi.live") {
          const live = change.value as LiveState | null;
          const wasRunning = facts.running === true;
          facts.running = live?.run !== undefined;
          facts.tools = live?.tools;
          touched.add(id);
          // A subagent's run keeps its call-given label; only ownerless and
          // forked conversations are candidates for a generated name.
          if (wasRunning && !facts.running && this.#records.get(id)?.owner === undefined) ended.add(id);
        } else if (this.#questionKinds.has(change.record.kind)) {
          const value = change.value;
          const pending = Value.Check(QuestionSchema, value) && value.requests.some((request) => request.resolution === undefined);
          const next = new Set(facts.pending);
          if (pending) next.add(change.record.kind);
          else next.delete(change.record.kind);
          facts.pending = next;
          touched.add(id);
        } else if (change.record.kind === RoleDoc.definition.kind) {
          facts.agent = roleNameOf(change.value as { name?: unknown } | null);
          touched.add(id);
        } else if (change.record.kind === SubagentDoc.definition.kind) {
          const value = change.value as { label?: unknown; role?: unknown } | null;
          facts.label = typeof value?.label === "string" && value.label !== "" ? value.label : undefined;
          facts.role = typeof value?.role === "string" && value.role !== "" ? value.role : undefined;
          touched.add(id);
        } else if (change.record.kind === TitleDoc.definition.kind) {
          const named = (change.value as { title?: unknown } | null)?.title;
          facts.named = typeof named === "string" && named !== "" ? named : undefined;
          touched.add(id);
        }
      }
      // document.copy is definition-free — a fork's initialized docs carry no new facts.
    }
    // pi.live republishes on every streamed token: only conversations a change
    // touched are re-derived, and only a real difference allocates a new list.
    this.#refreshSummaries(touched);
    // Last: listeners must see the summaries this commit produced. They may
    // not call Session APIs while the commit listener is still on the stack.
    for (const id of ended) for (const listener of this.#runEnd) listener(id);
  }

  /** `listener` fires inside the commit listener — defer any Session work out of it. */
  onRunEnd(listener: (id: ConversationId) => void): () => void {
    this.#runEnd.add(listener);
    return () => this.#runEnd.delete(listener);
  }

  /** Rebuild the role column after an index write; summaries whose resolved name moved are touched. */
  #reindex(index: HostIndex | null | undefined, touched: Set<ConversationId>): void {
    const next = rolesOf(index);
    for (const record of this.#records.values()) {
      if (
        record.owner === undefined
        && topLevelRole(record, this.#records, this.#roles) !== topLevelRole(record, this.#records, next)
      ) {
        touched.add(record.id);
      }
    }
    this.#roles = next;
  }

  /**
   * A summary's `role` is the creation agent: the subagent's call-given name,
   * else the top-level index entry's (inherited by forks). `currentAgent` is
   * the own RoleDoc, falling back to that role for pre-RoleDoc conversations.
   * A 5.18 host always sends it: no name anywhere means `null`, never absent
   * (absent is how clients recognize a pre-5.18 host).
   */
  #summaryOf(record: ConversationRecord): ConversationSummary {
    const facts = this.#fact(record.id);
    if (record.owner !== undefined) return summaryOf(record, facts, facts.role, facts.role ?? null);
    const role = topLevelRole(record, this.#records, this.#roles);
    return summaryOf(record, facts, role, (facts.agent === undefined ? role : facts.agent) ?? null);
  }

  /** Re-derive the touched ids' summaries; publishes #list only on a real difference. */
  #refreshSummaries(touched: Set<ConversationId>): void {
    let next: ConversationSummary[] | undefined;
    for (const id of touched) {
      const record = this.#records.get(id);
      if (record === undefined) continue;
      const summary = this.#summaryOf(record);
      const index = this.#index.get(id);
      if (index === undefined) {
        next ??= this.#list.slice();
        this.#index.set(id, next.length);
        next.push(summary);
      } else if (!sameSummary(this.#list[index]!, summary)) {
        next ??= this.#list.slice();
        next[index] = summary;
      }
    }
    if (next !== undefined) this.#set(next);
  }

  #fact(id: ConversationId): ConversationFacts {
    let facts = this.#facts.get(id);
    if (facts === undefined) this.#facts.set(id, (facts = { pending: new Set() }));
    return facts;
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

/** Per-conversation state the summary derives from, filled at open and kept by the commit listener. */
type ConversationFacts = {
  title?: string;
  /** The TitleDoc name — auto-generated or manual — winning over `title` when set. */
  named?: string;
  /** Newest own user/assistant entry seen; guards out-of-order changes within one publication. */
  newest?: EntryId;
  updatedAt?: number;
  failed?: boolean;
  /** A run is in flight (pi.live has `run`). */
  running?: boolean;
  /** callId → target, from the newest own assistant entry's tool calls. */
  calls?: ReadonlyMap<string, string | undefined>;
  /** The current tool round, kept verbatim from pi.live. */
  tools?: readonly ToolSlot[];
  /** Question doc kinds that currently hold an unresolved request. */
  pending: Set<string>;
  label?: string;
  /** The named agent the subagent ran as, if the call gave one. */
  role?: string;
  /** The own RoleDoc's name: a role, explicit null, or undefined when absent. */
  agent?: string | null;
};

/** A RoleDoc snapshot's current name; a shapeless or retired document reads as absent. */
function roleNameOf(value: { name?: unknown } | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value.name === "string" ? value.name : value.name === null ? null : undefined;
}

/** The top-level id → role column of an index value; absent/corrupt entries read as no role. */
function rolesOf(index: HostIndex | null | undefined): Map<ConversationId, string> {
  const roles = new Map<ConversationId, string>();
  for (const entry of index?.conversations ?? []) {
    if (typeof entry.role === "string" && entry.role !== "") roles.set(entry.id, entry.role);
  }
  return roles;
}

/**
 * The index-entry role a conversation shows: its own top-level entry's, or —
 * walking `parent` links — the ancestor's it forked from (ADR-0023 §7). A
 * broken chain (defensive; parents are never rewritten) resolves to none.
 */
function topLevelRole(
  record: ConversationRecord,
  records: ReadonlyMap<ConversationId, ConversationRecord>,
  roles: ReadonlyMap<ConversationId, string>,
): string | undefined {
  let current: ConversationRecord | undefined = record;
  const seen = new Set<ConversationId>();
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parent === undefined) return roles.get(current.id);
    current = records.get(current.parent.conversationId);
  }
  return undefined;
}

function summaryOf(
  record: ConversationRecord,
  facts: ConversationFacts,
  role: string | undefined,
  currentAgent: string | null,
): ConversationSummary {
  const parent = record.parent?.conversationId ?? record.owner?.conversationId;
  const status =
    facts.pending.size > 0 ? "needs-answer" : facts.running === true ? "running" : facts.failed === true ? "failed" : undefined;
  // The tool call in flight, named by the first running slot; its target comes
  // from the newest assistant entry's arguments, not the slot (they carry none).
  const runningSlot = facts.running === true ? facts.tools?.find((slot) => slot.status === "running") : undefined;
  const activity =
    runningSlot === undefined
      ? undefined
      : {
          tool: runningSlot.name,
          ...(facts.calls?.get(runningSlot.callId) === undefined ? {} : { target: facts.calls.get(runningSlot.callId) }),
        };
  return {
    id: record.id,
    kind: record.owner !== undefined ? "subagent" : record.parent !== undefined ? "fork" : "conversation",
    ...(parent === undefined ? {} : { parent }),
    // The client's forkable-entry ids are the string form of EntryId.
    ...(record.parent === undefined ? {} : { forkedAt: String(record.parent.at) }),
    ...((facts.named ?? facts.title) === undefined ? {} : { title: facts.named ?? facts.title }),
    ...(status === undefined ? {} : { status }),
    ...(facts.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt }),
    ...(facts.label === undefined ? {} : { label: facts.label }),
    ...(role === undefined ? {} : { role }),
    currentAgent,
    ...(activity === undefined ? {} : { activity }),
  };
}

function sameSummary(a: ConversationSummary, b: ConversationSummary): boolean {
  return (
    a.id === b.id
    && a.kind === b.kind
    && a.parent === b.parent
    && a.forkedAt === b.forkedAt
    && a.title === b.title
    && a.status === b.status
    && a.updatedAt === b.updatedAt
    && a.label === b.label
    && a.role === b.role
    && a.currentAgent === b.currentAgent
    && a.activity?.tool === b.activity?.tool
    && a.activity?.target === b.activity?.target
  );
}

function titleOf(entry: EntryRecord | undefined): { title?: string } {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return {};
  // The typed text, not the blocks the host writes around it (ADR-0028,
  // #321). Only a whole attachments text block is skipped; an attachment-only
  // message has no text — no title rather than an empty one.
  const title = stripUserBlocks(message.content).text.replace(/\s+/g, " ").trim();
  return title === "" ? {} : { title };
}

/**
 * What a scan of the conversation's own entries teaches the summary: the title is
 * the oldest own user message (a subagent's task; a fork's own first message, not
 * an inherited one), updatedAt and failed come from the newest own user/assistant
 * entry. Entries scan newest-first, so the newest match is the first hit.
 */
async function historyFacts(
  harness: Harness,
  id: ConversationId,
): Promise<Pick<ConversationFacts, "title" | "newest" | "updatedAt" | "failed" | "calls">> {
  const conversation = (await harness.conversation(id, context))!;
  let first: EntryRecord | undefined;
  let newest: EntryRecord | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, context);
    // The fallback title comes from the oldest own user message with text —
    // the live listener's titleOf gate; an image-only message yields none.
    first =
      page.items.findLast(
        (entry) => entry.kind === "pi.user" && entry.conversationId === id && titleOf(entry).title !== undefined,
      ) ?? first;
    newest ??= page.items.find(
      (entry) => entry.conversationId === id && (entry.kind === "pi.user" || entry.kind === "pi.assistant"),
    );
    cursor = page.next;
  } while (cursor !== undefined);
  const message = newest?.model?.[0];
  return {
    ...titleOf(first),
    // A newest entry without a numeric timestamp still marks newest and
    // failed — only updatedAt needs the timestamp. The commit listener
    // derives exactly the same three.
    ...(newest === undefined
      ? {}
      : {
          newest: newest.id,
          ...(typeof message?.timestamp === "number" ? { updatedAt: message.timestamp } : {}),
          failed: newest.kind === "pi.assistant" && message?.role === "assistant" && message.stopReason === "error",
          ...(newest.kind === "pi.assistant" ? { calls: callsOf(message) } : {}),
        }),
  };
}

/** callId → target, of an assistant message's tool call blocks. */
function callsOf(message: unknown): ReadonlyMap<string, string | undefined> | undefined {
  if ((message as { role?: string } | undefined)?.role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const calls = new Map<string, string | undefined>();
  for (const block of content as { type?: string; id?: string; arguments?: unknown }[]) {
    if (block?.type === "toolCall" && typeof block.id === "string") calls.set(block.id, toolTarget(block.arguments));
  }
  return calls.size === 0 ? undefined : calls;
}

type Subscription = { stop(): Promise<unknown> | void };
/**
 * `images` is set for a conversation stream subscribed with `images: "ref"`;
 * `view` is the raw value the last frame left the client at (the rewrite
 * target's source), so refs resolve against what this subscription currently
 * shows instead of a separate ref table.
 */
type SubscriptionState = { subscription?: Subscription; readonly images?: ImageRefs; view?: JsonValue };
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
  /** The gateway-wide file enumerator — shared so concurrent clients' queries ride one scan per root. */
  readonly #files: FileLister;
  /** The gateway-wide skills lister — concurrent clients' scope queries ride one scan. */
  readonly #skills: SkillLister;
  readonly #imageVariants: ImageVariants;
  /** Streams backed by an in-memory value pushed whole to subscribers on change. */
  #providerCalls(): Omit<ModelAuth, "close"> {
    const modelAuth = this.#options.modelAuth;
    if (modelAuth === undefined) throw new Error("Provider setup is not available on this host");
    return modelAuth;
  }

  readonly #hostValues: { [K in HostStreamName]?: HostValue<HostStreamValues[K]> };
  readonly #subscriptions = new Map<StreamName, SubscriptionState>();
  #disposed = false;

  constructor(connection: GatewayConnection, options: GatewayOptions, conversations: ConversationList, files: FileLister, skills: SkillLister, imageVariants: ImageVariants, hooks: ClientHooks) {
    this.#connection = connection;
    this.#options = options;
    this.#files = files;
    this.#skills = skills;
    this.#imageVariants = imageVariants;
    this.#hostValues = {
      conversations,
      mcp: options.mcp ?? constantValue<McpStatus | null>(null),
      models: options.modelAuth?.models ?? constantValue(options.modelSummaries()),
      auth: options.modelAuth?.auth ?? constantValue<HostAuth>({ logins: [] }),
      providers: options.modelAuth?.providers ?? constantValue<HostProviders>({ providers: [], logins: [] }),
      settings: options.settings,
      agents: options.agents ?? constantValue<AgentRoles>({ roles: [], problems: [] }),
    };
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
      defaults: settingsDefaults(options.settings.value),
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
    if (frame.type === "subscribe") await this.#subscribe(frame.stream, frame.images === "ref");
    else if (frame.type === "unsubscribe") await this.#unsubscribe(frame.stream);
    else await this.#answer(frame.id, frame.method, frame.args);
  }

  async #subscribe(stream: StreamName, imageRefs: boolean): Promise<void> {
    const previous = this.#subscriptions.get(stream);
    const state: SubscriptionState = imageRefs && stream.startsWith("conversation:") ? { images: new ImageRefs() } : {};
    this.#subscriptions.set(stream, state);
    const current = () => !this.#disposed && this.#subscriptions.get(stream) === state;
    const send: SendFrame = (frame) => (current() ? this.send(frame) : Promise.resolve());
    let subscription: Subscription;
    try {
      await previous?.subscription?.stop();
      if (!current()) return;
      subscription = await this.#open(stream, send, state);
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

  async #open(stream: StreamName, send: SendFrame, state: SubscriptionState | undefined): Promise<Subscription> {
    const source = this.#hostValue(stream);
    if (source !== undefined) {
      // Snapshot, then subscribe, with no await between — a change landing in
      // the gap would be lost.
      void send({ type: "snapshot", stream, value: source.value });
      return { stop: source.subscribe((value) => void send({ type: "snapshot", stream, value })) };
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
    if (stream.startsWith("doc:")) {
      const at = stream.lastIndexOf(":");
      return this.#openDoc(stream, stream.slice("doc:".length, at), Number(stream.slice(at + 1)) as ConversationId, send);
    }
    const conversation = await this.#conversation(Number(stream.slice("conversation:".length)) as ConversationId);
    return this.#forward(stream, await conversation.watch(context), send, state);
  }

  /** The in-memory value source for a host stream, or undefined for the watch-/doc-backed ones. */
  #hostValue(stream: StreamName): HostValue<unknown> | undefined {
    return Object.hasOwn(this.#hostValues, stream) ? this.#hostValues[stream as HostStreamName] : undefined;
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

  async #forward<T>(stream: StreamName, watch: WatchHandle<T>, send: SendFrame, state?: SubscriptionState): Promise<Subscription> {
    if (state?.images === undefined) {
      await send({ type: "snapshot", stream, value: watch.value });
      watch.start((_value, ops) => send({ type: "ops", stream, ops }));
      return watch;
    }
    const images = state.images;
    // Watch callbacks run one at a time, so `before` is always the value the last frame left the client at.
    let before = watch.value as JsonValue;
    // Keep the raw view alongside the ref form: #shownImage resolves a ref by
    // finding its block here, so nothing has to accumulate per ref.
    state.view = before;
    await send({ type: "snapshot", stream, value: await images.value(before) });
    watch.start(async (value, ops) => {
      const sent = await images.ops(ops, before);
      before = value as JsonValue;
      state.view = before;
      return send({ type: "ops", stream, ops: sent });
    });
    return watch;
  }

  /** The bytes behind a ref one of this connection's live ref subscriptions currently shows. */
  #shownImage(ref: string): MessageImage | undefined {
    for (const state of this.#subscriptions.values()) {
      if (state.images === undefined || state.view === undefined) continue;
      const image = state.images.image(state.view, ref);
      if (image !== undefined) return image;
    }
    return undefined;
  }

  #attachmentStore(): AttachmentStore {
    const store = this.#options.attachments;
    if (store === undefined) throw new Error("Attachments are not available on this host");
    return store;
  }

  /** Mark a message's attachments used and render the model's v1 block. */
  async #attachmentText(ids: readonly string[] | undefined): Promise<string | undefined> {
    if (ids === undefined || ids.length === 0) return undefined;
    const files = await this.#attachmentStore().use(ids);
    return files === undefined ? undefined : attachmentBlock(files);
  }

  /** Attached images with refs swapped back for their bytes, then checked like freshly sent ones. */
  #attached(images: readonly OutgoingImage[] | undefined): MessageImage[] | undefined {
    const resolved = images?.map((image, index) => {
      if ("data" in image) return image;
      const shown = this.#shownImage(image.ref);
      if (shown === undefined) throw new Error(`Image ${index + 1} is no longer available`);
      return shown;
    });
    const problem = imageProblem(resolved ?? []);
    if (problem !== undefined) throw new Error(problem);
    return resolved;
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

  /** Start a manual compaction and report its outcome as a notice once it settles. */
  async #compact(conversation: Conversation, instructions: string | undefined): ReturnType<Conversation["compact"]> {
    const taskId = await conversation.compact(instructions, context);
    void this.#options.harness.waitForTask(taskId, context).then(
      (receipt) => void this.send({ type: "notice", level: "info", message: `Compaction ${receipt.state.outcome.status}.` }),
      () => {},
    );
    return taskId;
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
      case "submit": {
        const input = args as CallMethods["submit"]["args"];
        // Resolve refs before the first await: this frame arrived while the
        // subscription was live, and a client may unsubscribe while the host
        // is still reading the conversation. Looking the ref up afterwards
        // would turn an accepted submit into "no longer available".
        const images = this.#attached(input.images);
        const conversation = await this.#conversation(input.conversationId);
        // Mark attachments used before the message write (issue #321); the
        // store's lock is the same one cleanup sweeps under, so a used file
        // can never be deleted between these two steps.
        const attachments = await this.#attachmentText(input.attachments);
        const text = await this.#expandSkills(input.text, { kind: "conversation", conversationId: conversation.id }, input.skills);
        // A pending question never blocks the composer (ADR-0011 §4): mark it
        // dismissed so its wait task finishes, then steer regardless.
        const dismissed = await this.#dismissPendingQuestions(conversation.id, context);
        const submission = await conversation.submit(
          {
            type: "input",
            content: messageContent(text, images, attachments),
            whenBusy: dismissed ? "steer" : input.whenBusy,
            requestId: input.requestId,
          },
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
      case "createConversation": {
        const create = args as CallMethods["createConversation"]["args"];
        // Same rule as submit: resolve before createConversation's first await.
        const images = this.#attached(create.images);
        const attachments = await this.#attachmentText(create.attachments);
        // The conversation does not exist yet: expand against the scope the
        // draft's `$` menu listed (a worktree draft reads the project's
        // committed skills in place — its checkout is created later).
        const text = await this.#expandSkills(
          create.text,
          create.home.kind === "chat"
            ? { kind: "chat" }
            : { kind: "project", path: create.home.path, checkout: create.checkout ?? "worktree" },
          create.skills,
        );
        const conversationId = await createConversation(
          this.#options.harness,
          this.#options.dataDir,
          {
            home: create.home,
            text,
            requestId: create.requestId,
            ...(images === undefined ? {} : { images }),
            ...(attachments === undefined ? {} : { attachmentText: attachments }),
            ...(create.checkout === undefined ? {} : { checkout: create.checkout }),
            ...(create.model === undefined ? {} : { model: create.model }),
            ...(create.thinkingLevel === undefined ? {} : { thinkingLevel: create.thinkingLevel }),
            ...(create.agent === undefined ? {} : { agent: create.agent }),
          },
          settingsDefaults(this.#options.settings.value),
          this.#options.models,
          this.#options.modelSummaries,
          this.#options.agents?.value ?? { roles: [], problems: [] },
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
      case "setPushToken": {
        const device = this.devicePublicKey;
        if (device === undefined) throw new Error("Push tokens register over the secure channel only");
        // Pushes ride the account control connection: a host that never
        // joined has nowhere to send them (ADR-0025 §7). Read fresh — a join
        // writes server.json without restarting the host.
        const joined = async (): Promise<boolean> =>
          (await readServerConfig(this.#options.dataDir).catch(() => undefined)) !== undefined;
        await setPushToken(this.#options.harness, device, (args as CallMethods["setPushToken"]["args"]).token, context, joined);
        return null;
      }
      case "logout": {
        const modelAuth = this.#options.modelAuth;
        if (modelAuth === undefined) throw new Error("Logging out is not available on this host");
        await modelAuth.logout((args as CallMethods["logout"]["args"]).providerId);
        return null;
      }
      case "beginLogin": {
        const { providerId, method } = args as CallMethods["beginLogin"]["args"];
        return { loginId: this.#providerCalls().beginLogin(providerId, method) };
      }
      case "answerLogin": {
        const { loginId, promptId, value } = args as CallMethods["answerLogin"]["args"];
        this.#providerCalls().answerLogin(loginId, promptId, value);
        return null;
      }
      case "cancelLogin": {
        this.#providerCalls().cancelLogin((args as CallMethods["cancelLogin"]["args"]).loginId);
        return null;
      }
      case "saveCustomProvider": {
        const { provider, apiKey } = args as CallMethods["saveCustomProvider"]["args"];
        await this.#providerCalls().saveCustomProvider(provider, apiKey);
        return null;
      }
      case "removeCustomProvider": {
        await this.#providerCalls().removeCustomProvider((args as CallMethods["removeCustomProvider"]["args"]).providerId);
        return null;
      }
      case "listEndpointModels": {
        return { models: await this.#providerCalls().listEndpointModels(args as CallMethods["listEndpointModels"]["args"]) };
      }
      case "updateSettings": {
        await this.#options.settings.update((args as CallMethods["updateSettings"]["args"]).patch);
        return null;
      }
      case "createAgent": {
        const store = this.#options.agents;
        if (store === undefined) throw new Error("Named agents are not available on this host");
        await store.create((args as CallMethods["createAgent"]["args"]).role);
        return null;
      }
      case "updateAgent": {
        const store = this.#options.agents;
        if (store === undefined) throw new Error("Named agents are not available on this host");
        await store.update((args as CallMethods["updateAgent"]["args"]).role);
        return null;
      }
      case "deleteAgent": {
        const store = this.#options.agents;
        if (store === undefined) throw new Error("Named agents are not available on this host");
        await store.remove((args as CallMethods["deleteAgent"]["args"]).name);
        return null;
      }
      case "listFolders":
        return listFolders((args as CallMethods["listFolders"]["args"]).path, homedir());
      case "listFiles": {
        const input = args as CallMethods["listFiles"]["args"];
        return listFiles(this.#options.harness, this.#options.dataDir, this.#files, input.scope, input.query, context);
      }
      case "listSkills": {
        const input = args as CallMethods["listSkills"]["args"];
        return listSkills(this.#options.harness, this.#skills, input.scope, context);
      }
      case "image": {
        const input = args as CallMethods["image"]["args"];
        const image = this.#shownImage(input.ref);
        if (image === undefined) throw new Error("Unknown image");
        if (input.variant === undefined) return image;
        const derived = await this.#imageVariants.get(input.ref, input.variant, image);
        if (this.#shownImage(input.ref) === undefined) throw new Error("Unknown image");
        return derived;
      }
      case "beginAttachment": {
        const input = args as CallMethods["beginAttachment"]["args"];
        const store = this.#attachmentStore();
        return { attachmentId: await store.begin(input.name, input.size) };
      }
      case "appendAttachment": {
        const input = args as CallMethods["appendAttachment"]["args"];
        const store = this.#attachmentStore();
        return await store.append(input.attachmentId, input.offset, input.data);
      }
    }
    const conversation = await this.#conversation((args as { conversationId: ConversationId }).conversationId);
    switch (method) {
      case "withdrawQueued": {
        const { conversationId, submissionId } = args as CallMethods["withdrawQueued"]["args"];
        const id = submissionId as SubmissionId;
        const submission = await this.#options.harness.submission(id, context);
        if (submission === undefined) throw new Error(`Submission ${submissionId} does not exist`);
        assertQueuedInput(await submission.status(context), conversationId);
        await this.#options.harness.abortSubmission(id, context, conversationId);
        // Read the record after the abort: "sent" means the input reached the
        // transcript (it has an entry), not that its status is still placed.
        // An aborted run settles a placed input unanswered/aborted yet keeps
        // its entry, so the status cannot decide this.
        const after = await this.#options.harness.submission(id, context);
        if (after === undefined) throw new Error(`Submission ${submissionId} does not exist`);
        return { outcome: (await after.status(context)).entry === undefined ? "withdrawn" : "sent" };
      }
      case "steerQueued": {
        const { conversationId, submissionId } = args as CallMethods["steerQueued"]["args"];
        const id = submissionId as SubmissionId;
        return await this.#options.harness.commit(async (tx) => {
          const record = await (tx as SubmissionReadTx).submission(id);
          if (record === undefined) throw new Error(`Submission ${submissionId} does not exist`);
          assertQueuedInput(record, conversationId);
          if (record.entry !== undefined) return { outcome: "sent" as const };
          if (record.status !== "queued") return { outcome: "unavailable" as const };
          const inbox = await tx.doc(InboxDoc, conversationId);
          const item = inbox.items.find((candidate) => candidate.id === id);
          if (item === undefined) {
            throw new Error(`Submission ${submissionId} is not queued in the inbox`);
          }
          // Only steered closes a question (ADR-0011 §4): the mode change and
          // the dismissal share this commit, so the agent is never released
          // without the user's new input.
          await dismissPendingQuestions(tx, this.#questionDocs(), conversationId);
          if (item.mode === "followUp") item.mode = "steer";
          return { outcome: "steered" as const };
        }, context);
      }
      case "renameConversation": {
        const { title } = args as CallMethods["renameConversation"]["args"];
        const trimmed = title.trim();
        if (trimmed === "") throw new Error("Title cannot be empty");
        if (trimmed.length > 200) throw new Error("Title is too long (200 characters at most)");
        await this.#options.harness.commit(async (tx) => {
          const record = await tx.conversation(conversation.id);
          if (record === undefined) throw new Error(`Conversation ${conversation.id} does not exist`);
          if (record.owner !== undefined) {
            throw new Error("Subagent conversations are named by the call that started them");
          }
          const doc = await tx.doc(TitleDoc, conversation.id);
          doc.title = trimmed;
          doc.source = "manual";
        }, context);
        return null;
      }
      case "abort":
        await conversation.abort(context);
        return null;
      case "compact": {
        const { instructions } = args as CallMethods["compact"]["args"];
        return { taskId: await this.#compact(conversation, instructions) };
      }
      case "listCommands":
        return listCommands();
      case "runCommand": {
        const { name, args: input } = args as CallMethods["runCommand"]["args"];
        await runCommand({ compact: (instructions) => this.#compact(conversation, instructions) }, name, input);
        return null;
      }
      case "setModel": {
        const { model: ref } = args as CallMethods["setModel"]["args"];
        const model = this.#options.models.getModel(ref.provider, ref.modelId);
        if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
        // Read and write in one commit: a snapshot read before the commit could
        // overwrite a thinking level another call committed meanwhile.
        await this.#options.harness.commit(async (tx) => {
          const state = await tx.doc(AgentDoc, conversation.id);
          const thinking: ModelThinkingLevel = state.thinkingLevel ?? "off";
          await configure(tx, conversation.id, { model: ref, thinkingLevel: clampThinkingLevel(model, thinking) });
        }, context);
        return null;
      }
      case "setThinkingLevel": {
        const { level } = args as CallMethods["setThinkingLevel"]["args"];
        await this.#options.harness.commit(async (tx) => {
          const state = await tx.doc(AgentDoc, conversation.id);
          const model =
            state.model === undefined
              ? undefined
              : this.#options.models.getModel(state.model.provider, state.model.modelId);
          if (model === undefined) throw new Error("No model selected");
          if (!getSupportedThinkingLevels(model).includes(level)) {
            throw new Error(`Thinking level ${level} is not supported by ${state.model!.provider}/${state.model!.modelId}`);
          }
          await configure(tx, conversation.id, { thinkingLevel: level });
        }, context);
        return null;
      }
      case "setAgent": {
        const { conversationId, agent } = args as CallMethods["setAgent"]["args"];
        await setAgent(
          this.#options.harness,
          { conversationId, agent },
          this.#options.models,
          this.#options.modelSummaries,
          this.#options.agents?.value ?? { roles: [], problems: [] },
          context,
        );
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
          // The fork inherits the parent's agent — same cwd, the same execution
          // checkout (ADR-0019 §1). Its copied RoleDoc arrives definition-free;
          // reading it once materializes the inherited name into a valued
          // publication, so summary projection sees the fork's own name.
          const fork = await conversation.fork(
            at,
            {
              ownership: { kind: "ownerless" },
              ...(remove.length === 0 ? {} : { agent: { tools: { remove } } }),
              init: async (tx, id) => {
                await tx.doc(RoleDoc, id);
              },
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
   * `text` as the model reads it: the invoked skills of `scope` in front, in
   * pi's `/skill:` format (ADR-0028). `bound` is what a 5.16 client picked
   * from the `$` menu — exactly those expand, in that order, and `[]` means
   * none; without it (an older client) the text's `$name` mentions decide.
   * It never fails the send — an unlisted scope, a name not in scope, or an
   * unreadable file leaves the text (or that skill) as typed, with a notice.
   */
  async #expandSkills(text: string, scope: SkillScope, bound: readonly string[] | undefined): Promise<string> {
    // Nothing picked, or (for an older client) no `$` at all: skip the listing.
    if (bound === undefined ? !text.includes("$") : bound.length === 0) return text;
    let skills: readonly ListedSkill[];
    try {
      skills = await scopeSkills(this.#options.harness, this.#skills, scope, context);
    } catch (error) {
      void this.send({
        type: "notice",
        level: "warning",
        message: `Skills were not expanded: ${error instanceof Error ? error.message : String(error)}`,
      });
      return text;
    }
    const names = bound ?? mentionedSkillNames(text, skills.map((skill) => skill.name));
    const expanded = await expandSkills(text, names, skills);
    for (const name of expanded.missing) {
      void this.send({ type: "notice", level: "warning", message: `Skill "${name}" is not available here; sent without it` });
    }
    for (const failure of expanded.failures) {
      void this.send({
        type: "notice",
        level: "error",
        message: `Could not read skill "${failure.name}" (${failure.filePath}): ${failure.message}`,
      });
    }
    return expanded.text;
  }

  /**
   * Mark every unresolved `pinomad.question` request of a conversation
   * dismissed — the user chose to reply in chat instead (ADR-0011 §4). The wait
   * task sees the doc change and ends the tool. True when any were dismissed.
   */
  async #dismissPendingQuestions(conversationId: ConversationId, context: Context): Promise<boolean> {
    const questionDocs = this.#questionDocs();
    // Snapshot first: submits happen on every message, so committing blindly
    // would write on every send and materialize an empty doc per conversation.
    const snapshots = await Promise.all(questionDocs.map((doc) => this.#options.harness.snapshot(doc.token, conversationId, context)));
    const pending = snapshots.some(
      (value) => Value.Check(QuestionSchema, value) && value.requests.some((request) => request.resolution === undefined),
    );
    if (!pending) return false;
    return await this.#options.harness.commit(
      (tx) => dismissPendingQuestions(tx, questionDocs, conversationId),
      context,
    );
  }

  /** This host's `pinomad.question` docs, in the order the hello declares them. */
  #questionDocs(): readonly ExtensionDoc[] {
    return (this.#options.docs ?? []).filter((doc) => doc.presentation === "pinomad.question");
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
      const [changes, branch] = await Promise.all([changesOf(record.path, record.base), branchOf(record.path)]);
      return { available: true as const, ...changes, branch };
    }
    // The branch reads alongside the repository probe so it costs no extra wait.
    const [base, branch] = await Promise.all([gitBase(cwd), branchOf(cwd)]);
    if (base === undefined) return { available: false as const, reason: "Not in a git repository", branch };
    return { available: true as const, ...(await changesOf(base.repo, base.base)), branch };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const state of subscriptions) await state.subscription?.stop();
  }
}
