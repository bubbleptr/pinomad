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
  type HostToRelay,
} from "@pinomad/protocol/relay.ts";
import { serveWebClient } from "@pinomad/host/src/web-client.ts";

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
}

export interface Relay {
  readonly port: number;
  readonly url: string;
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

  const controls = new Map<string, WebSocket>();
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
      // Signature before allowlist: an unsigned claim must not learn which
      // hostIds are allowed.
      const verified = verifyRelayChallenge(frame.signature, { relayOrigin: publicOrigin, hostId: frame.hostId, nonce });
      if (!verified) {
        socket.close(RELAY_CLOSE.badSignature);
        return;
      }
      if (!allowedHosts.has(frame.hostId)) {
        socket.close(RELAY_CLOSE.hostNotAllowed);
        return;
      }
      hostId = frame.hostId;
      clearTimeout(deadline);
      const previous = controls.get(hostId);
      // A second registration wins: a reconnecting host must not be locked out
      // by a zombie control socket from its previous life.
      if (previous !== undefined) previous.close(RELAY_CLOSE.replaced);
      controls.set(hostId, socket);
      socket.send(encodeRelayFrame({ t: "registered" }));
    });

    socket.once("close", () => {
      clearTimeout(deadline);
      // A replaced control must not evict its successor.
      if (hostId !== undefined && controls.get(hostId) === socket) controls.delete(hostId);
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
    const control = controls.get(hostId);
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
    if (pathname === HOST_PATH) upgrade(onControl);
    else if (device !== null) upgrade((ws) => onDevice(ws, device[1]!));
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
    async close() {
      clearInterval(pingTimer);
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      for (const socket of sockets) socket.terminate();
      const closing = once(wss, "close");
      wss.close();
      await closing;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
