// The self-hosted relay (ADR-0008 phase 2): hosts and devices both dial out
// to it, and it splices their WebSockets together. Everything past the control
// handshake is already Noise-encrypted — the relay forwards opaque bytes and
// stores nothing. Runs on Node.

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  decodeHostToRelay,
  encodeRelayFrame,
  RELAY_CLOSE,
  verifyRelayChallenge,
  verifyRelayChallengeV2,
  type HostToRelay,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { serveWebClient } from "@pinomad/host/src/web-client.ts";
import type { Accounts } from "./accounts.ts";
import { handleApiRequest, secureTransport } from "./api.ts";

export interface RelayOptions {
  /** 0 in tests. */
  readonly port: number;
  /** Production sits behind Caddy for TLS, so loopback is the default. */
  readonly listenHost?: string;
  /** Public origin clients pair against; trailing slashes are stripped. */
  readonly publicOrigin: string;
  readonly allowedHosts: readonly string[];
  readonly acceptTimeoutMs?: number;
  readonly registerTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  /** Serve the built web client over plain HTTP on the same port; unset → 404. */
  readonly webRoot?: string;
  /**
   * Opened account store (ADR-0022): mounts /api/*, admits hosts bound in the
   * hosts table, and requires TLS-visible transport on /api and /host. The
   * relay takes ownership — close() closes it.
   */
  readonly accounts?: Accounts;
  /**
   * Trust X-Forwarded-For/Proto from the terminating proxy. Account mode only;
   * without it the API and control socket stay loopback-plaintext-only.
   */
  readonly trustProxy?: boolean;
}

export interface Relay {
  readonly port: number;
  readonly url: string;
  /**
   * What a host's live control connection reported at register: the Noise key
   * only when a v2 signature bound it, plus declared `features`. In-memory by
   * design — the pairing step compares it against the stored binding.
   */
  controlInfo(hostId: string): { readonly noisePublicKey?: string; readonly features?: readonly string[] } | undefined;
  close(): Promise<void>;
}

// Noise records are ≤ 65535 bytes; 128 KiB leaves generous headroom.
const MAX_PAYLOAD = 128 * 1024;
// Cap on bytes buffered from a device that hasn't been accepted yet — the
// first Noise handshake message arrives before accept, so it must be held.
const MAX_BUFFERED = 64 * 1024;
// Per-direction splice water marks: pause reading the source once the
// destination owes it more than HIGH_WATER, resume below LOW_WATER.
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

const HOST_PATH = "/host";
const DEVICE_PATH = /^\/c\/([A-Za-z0-9_-]{43})$/;
const ACCEPT_PATH = /^\/accept\/([A-Za-z0-9_-]{22})$/;

// ws can only send these; anything else (1005/1006/1015+, app codes below
// 3000) is forwarded as a generic 1001.
const isSendableCloseCode = (code: number): boolean =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

interface Buffered {
  readonly data: RawData;
  readonly isBinary: boolean;
}

interface PendingDevice {
  /** The control connection this device's `incoming` was announced on. */
  readonly control: WebSocket;
  readonly socket: WebSocket;
  readonly buffered: Buffered[];
  bufferedBytes: number;
  readonly timer: NodeJS.Timeout;
  readonly onMessage: (data: RawData, isBinary: boolean) => void;
  readonly onClose: () => void;
}

const rawLength = (data: RawData): number => (Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data.byteLength);

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const publicOrigin = options.publicOrigin.replace(/\/+$/, "");
  if (publicOrigin === "") throw new Error("publicOrigin is required");
  const allowedHosts = new Set(options.allowedHosts);
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 10_000;
  const registerTimeoutMs = options.registerTimeoutMs ?? 10_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const listenHost = options.listenHost ?? "127.0.0.1";
  const accounts = options.accounts;
  const trustProxy = options.trustProxy ?? false;

  interface ControlEntry {
    readonly socket: WebSocket;
    /** The host's current Noise key — set only when a v2 signature bound it. */
    readonly noisePublicKey?: string;
    readonly features?: readonly string[];
  }

  const controls = new Map<string, ControlEntry>();
  const pending = new Map<string, PendingDevice>();
  const sockets = new Set<WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();

  function track(socket: WebSocket): void {
    sockets.add(socket);
    // Alive until the first ping says otherwise — a socket that just connected
    // gets one full interval to prove it pongs.
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.terminate());
  }

  function splice(a: WebSocket, b: WebSocket): void {
    const forward = (from: WebSocket, to: WebSocket): void => {
      from.on("message", (data: RawData, isBinary: boolean) => {
        if (to.readyState !== WebSocket.OPEN) return;
        to.send(data, { binary: isBinary }, () => {
          if (from.isPaused && to.bufferedAmount <= LOW_WATER) from.resume();
        });
        // Pausing stops reading the peer, so TCP backpressure reaches the
        // sender instead of piling up in relay memory; a peer that never
        // drains is reaped by the ping/terminate loop. (pause/resume are
        // no-ops on CONNECTING/CLOSED sockets in ws 8.x.)
        if (to.bufferedAmount > HIGH_WATER) from.pause();
      });
      from.on("close", (code: number, reason: Buffer) => {
        if (to.readyState !== WebSocket.OPEN) return;
        to.close(isSendableCloseCode(code) ? code : 1001, reason);
      });
    };
    forward(a, b);
    forward(b, a);
  }

  /**
   * Handles one join/leave op connection (ADR-0022 §3). The register's Ed25519
   * signature is already verified; this only runs the operation, replies, and
   * hangs up. `noisePublicKey` is present only when a v2 signature bound it.
   */
  function runOp(socket: WebSocket, frame: HostToRelay, noisePublicKey: string | undefined): void {
    // Reply, then hang up in the send callback so the close can't race it.
    const answer = (reply: RelayToHost): void =>
      socket.send(encodeRelayFrame(reply), () => socket.close(1000));
    if (accounts === undefined) {
      answer({ t: "refused", reason: "accounts_disabled" });
      return;
    }
    if (frame.op === "join") {
      // A binding without a v2-bound Noise key would be unverifiable later —
      // pairing compares the live report against this row.
      if (frame.joinToken === undefined || noisePublicKey === undefined) {
        answer({ t: "refused", reason: "bad_request" });
        return;
      }
      const result = accounts.joinHost({
        token: frame.joinToken,
        hostId: frame.hostId,
        noisePublicKey,
        ...(frame.name === undefined ? {} : { name: frame.name }),
      });
      answer(result.status === "joined" ? { t: "joined", username: result.username } : { t: "refused", reason: result.reason });
      return;
    }
    if (!accounts.leaveHost(frame.hostId)) {
      answer({ t: "refused", reason: "not_joined" });
      return;
    }
    answer({ t: "left" });
    // The binding is gone: unless the static allowlist still admits it, the
    // host's live control connection loses its authorization right now.
    if (!allowedHosts.has(frame.hostId)) controls.get(frame.hostId)?.socket.close(RELAY_CLOSE.hostNotAllowed);
  }

  function onControl(socket: WebSocket): void {
    track(socket);
    const nonce = randomBytes(32).toString("base64url");
    socket.send(encodeRelayFrame({ t: "challenge", nonce }));
    let hostId: string | undefined;
    const deadline = setTimeout(() => socket.close(1008, "register timeout"), registerTimeoutMs);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      // The control channel is JSON text only; anything else — including a
      // second register — is a protocol violation.
      if (hostId !== undefined || isBinary) {
        socket.close(1008, "unexpected frame");
        return;
      }
      let frame: HostToRelay;
      try {
        frame = decodeHostToRelay(data.toString());
      } catch {
        socket.close(1008, "malformed frame");
        return;
      }
      // Signature before admission and before any op work: an unsigned claim
      // must not learn which hostIds are allowed, and a join token must never
      // be consumed by a frame that can't prove the host key.
      let noisePublicKey: string | undefined;
      if (frame.signatureV2 !== undefined) {
        // v2 binds the reported Noise key. A frame that offers v2 but fails it
        // is rejected outright — never downgraded to a v1 check.
        const bound =
          frame.noisePublicKey !== undefined &&
          verifyRelayChallengeV2(frame.signatureV2, {
            relayOrigin: publicOrigin,
            hostId: frame.hostId,
            nonce,
            noisePublicKey: frame.noisePublicKey,
          });
        if (!bound) {
          socket.close(RELAY_CLOSE.badSignature);
          return;
        }
        noisePublicKey = frame.noisePublicKey;
      } else if (!verifyRelayChallenge(frame.signature, { relayOrigin: publicOrigin, hostId: frame.hostId, nonce })) {
        socket.close(RELAY_CLOSE.badSignature);
        return;
      }
      // join/leave are one-shot operation connections: they never enter
      // `controls`, so a CLI doing them can't kick the running host's control.
      if (frame.op !== undefined) {
        runOp(socket, frame, noisePublicKey);
        return;
      }
      // Admission = static allowlist (legacy, migration window) or a host row
      // bound to an account (ADR-0022; join lands in a later step).
      if (!allowedHosts.has(frame.hostId) && accounts?.hasHost(frame.hostId) !== true) {
        socket.close(RELAY_CLOSE.hostNotAllowed);
        return;
      }
      hostId = frame.hostId;
      clearTimeout(deadline);
      const previous = controls.get(hostId);
      // A second registration wins: a reconnecting host must not be locked out
      // by a zombie control socket from its previous life.
      if (previous !== undefined) previous.socket.close(RELAY_CLOSE.replaced);
      controls.set(hostId, {
        socket,
        ...(noisePublicKey === undefined ? {} : { noisePublicKey }),
        ...(frame.features === undefined ? {} : { features: frame.features }),
      });
      // A bound host's successful register is also its heartbeat for the
      // account: keep last_seen_at fresh so /api/hosts can report online age.
      accounts?.markHostSeen(hostId);
      socket.send(encodeRelayFrame({ t: "registered" }));
    });

    socket.once("close", () => {
      clearTimeout(deadline);
      // A replaced control must not evict its successor.
      if (hostId !== undefined && controls.get(hostId)?.socket === socket) controls.delete(hostId);
      for (const [connId, entry] of pending) {
        if (entry.control === socket) {
          pending.delete(connId);
          clearTimeout(entry.timer);
          entry.socket.close(RELAY_CLOSE.hostOffline);
        }
      }
    });
  }

  function onDevice(socket: WebSocket, hostId: string): void {
    track(socket);
    const control = controls.get(hostId)?.socket;
    if (control === undefined) {
      socket.close(RELAY_CLOSE.hostOffline);
      return;
    }
    const connId = randomBytes(16).toString("base64url");
    const entry: PendingDevice = {
      control,
      socket,
      buffered: [],
      bufferedBytes: 0,
      timer: setTimeout(() => {
        if (pending.delete(connId)) socket.close(RELAY_CLOSE.acceptTimeout);
      }, acceptTimeoutMs),
      onMessage(data, isBinary) {
        entry.buffered.push({ data, isBinary });
        entry.bufferedBytes += rawLength(data);
        if (entry.bufferedBytes > MAX_BUFFERED && pending.delete(connId)) {
          clearTimeout(entry.timer);
          socket.close(1009);
        }
      },
      onClose() {
        if (pending.delete(connId)) clearTimeout(entry.timer);
      },
    };
    pending.set(connId, entry);
    socket.on("message", entry.onMessage);
    socket.once("close", entry.onClose);
    control.send(encodeRelayFrame({ t: "incoming", connId }));
  }

  function onAccept(socket: WebSocket, connId: string): void {
    track(socket);
    const entry = pending.get(connId);
    if (entry === undefined) {
      socket.close(RELAY_CLOSE.unknownConnection);
      return;
    }
    pending.delete(connId);
    clearTimeout(entry.timer);
    const device = entry.socket;
    device.removeListener("message", entry.onMessage);
    device.removeListener("close", entry.onClose);
    splice(socket, device);
    for (const { data, isBinary } of entry.buffered) socket.send(data, { binary: isBinary });
  }

  const httpServer = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    } catch {
      pathname = "";
    }
    // /api owns its prefix ahead of the static web client — without accounts a
    // JSON 404, never the SPA fallback (clients probe /api/me to detect them).
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (accounts === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "accounts_disabled" }));
        return;
      }
      void handleApiRequest(request, response, { accounts, publicOrigin, trustProxy }).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
    // Behind Caddy this port also is where phones load the web client from.
    if (options.webRoot !== undefined) {
      void serveWebClient(request, response, options.webRoot).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    } catch {
      pathname = "";
    }
    const upgrade = (handle: (ws: WebSocket) => void): void => {
      wss.handleUpgrade(request, socket, head, handle);
    };
    const device = DEVICE_PATH.exec(pathname);
    const accept = ACCEPT_PATH.exec(pathname);
    if (pathname === HOST_PATH) {
      // In account mode the control channel is TLS-only like the API: plaintext
      // stays for localhost development, otherwise the proxy must attest https.
      if (accounts !== undefined && !secureTransport(request, trustProxy)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
      } else {
        upgrade(onControl);
      }
    } else if (device !== null) upgrade((ws) => onDevice(ws, device[1]!));
    else if (accept !== null) upgrade((ws) => onAccept(ws, accept[1]!));
    else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("listening", resolveListen);
    httpServer.once("error", reject);
    httpServer.listen(options.port, listenHost);
  });
  const { port } = httpServer.address() as AddressInfo;

  // Browsers and Node ws auto-pong; a peer that stays silent across a whole
  // interval is dead and gets terminated, which propagates as 1001 (rule 5).
  // Created only after listen() succeeded — a failed bind must not leak it.
  const pingTimer = setInterval(() => {
    for (const socket of sockets) {
      if (alive.get(socket) === true) {
        alive.set(socket, false);
        socket.ping();
      } else {
        socket.terminate();
      }
    }
  }, pingIntervalMs);

  return {
    port,
    url: `ws://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${port}`,
    controlInfo(hostId) {
      const entry = controls.get(hostId);
      if (entry === undefined) return undefined;
      return {
        ...(entry.noisePublicKey === undefined ? {} : { noisePublicKey: entry.noisePublicKey }),
        ...(entry.features === undefined ? {} : { features: entry.features }),
      };
    },
    async close() {
      clearInterval(pingTimer);
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      for (const socket of sockets) socket.terminate();
      const closing = once(wss, "close");
      wss.close();
      await closing;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await accounts?.close();
    },
  };
}
