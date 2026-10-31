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
  type PushFrame,
  type PushVerdict,
  RELAY_CLOSE,
  verifyRelayChallenge,
  verifyRelayChallengeV2,
  type HostToRelay,
  type RegisterFrame,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { serveWebClient } from "@pinomad/host/src/web-client.ts";
import type { ApnsSender } from "./apns.ts";
import type { Accounts } from "./accounts.ts";
import {
  handleApiRequest,
  secureTransport,
  type PairingBroker,
  type PairingRequestResult,
  type PairingStatus,
} from "./api.ts";

export interface RelayOptions {
  /** 0 in tests. */
  readonly port: number;
  /** Production sits behind Caddy for TLS, so loopback is the default. */
  readonly listenHost?: string;
  /** Public origin clients pair against; trailing slashes are stripped. */
  readonly publicOrigin: string;
  readonly acceptTimeoutMs?: number;
  readonly registerTimeoutMs?: number;
  /** How long a server-vouched pairing ask waits for the host; default 10 s. */
  readonly pairingTimeoutMs?: number;
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
  /**
   * The opened APNs sender (ADR-0025): declared environments go out on every
   * `registered`, and bound hosts' `push` frames get forwarded to Apple.
   * The relay takes ownership — close() closes it.
   */
  readonly push?: ApnsSender;
  /** In-flight push caps, for tests; defaults below. */
  readonly pushLimits?: { readonly perHost?: number; readonly total?: number };
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
  /** Server-vouched pairing asks (ADR-0022 §4); the API routes drive it. */
  readonly pairing: PairingBroker;
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

// In-flight pairing asks per host / per session stay small: the client UI
// issues these one at a time, so anything beyond is abuse or a bug.
const MAX_PAIRING_PER_HOST = 4;
const MAX_PAIRING_PER_SESSION = 2;

// Push sends awaiting an APNs answer: capped per host and globally so a push
// burst can't crowd the control connections and starve pairing/splicing
// (ADR-0025 §4).
const MAX_PUSH_PER_HOST = 4;
const MAX_PUSH_TOTAL = 32;

interface PendingPairing {
  /** The exact control socket the request went out on. */
  readonly control: WebSocket;
  readonly hostId: string;
  /** The session token this request runs under — keys the per-session cap. */
  readonly sessionKey: string;
  readonly settle: (result: PairingRequestResult) => void;
  readonly timer: NodeJS.Timeout;
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const publicOrigin = options.publicOrigin.replace(/\/+$/, "");
  if (publicOrigin === "") throw new Error("publicOrigin is required");
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 10_000;
  const registerTimeoutMs = options.registerTimeoutMs ?? 10_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const listenHost = options.listenHost ?? "127.0.0.1";
  const accounts = options.accounts;
  const trustProxy = options.trustProxy ?? false;
  const pairingTimeoutMs = options.pairingTimeoutMs ?? 10_000;
  const apns = options.push;
  const pushEnvironments = apns?.environments ?? [];
  const pushPerHost = options.pushLimits?.perHost ?? MAX_PUSH_PER_HOST;
  const pushTotal = options.pushLimits?.total ?? MAX_PUSH_TOTAL;
  // Sends currently awaiting an APNs answer — the counters the caps read.
  let pushInflightTotal = 0;
  const pushInflightHosts = new Map<string, number>();

  interface ControlEntry {
    readonly socket: WebSocket;
    /** The host's current Noise key — set only when a v2 signature bound it. */
    readonly noisePublicKey?: string;
    readonly features?: readonly string[];
  }

  const controls = new Map<string, ControlEntry>();
  const pending = new Map<string, PendingDevice>();
  /**
   * Server-vouched pairing asks in flight (ADR-0022 §4), keyed by requestId.
   * Each is pinned to the exact control socket it was sent on — a reply on a
   * different (replaced) connection can never settle it.
   */
  const pairingRequests = new Map<string, PendingPairing>();
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
   * Whether a bound host can be asked for a pairing offer right now
   * (ADR-0022 §4). "host_too_old" covers both a control that never declared
   * the feature and a v1-only register that bound no Noise key — asking
   * either would just crash its decoder or waste the wait.
   */
  function pairingStatus(hostId: string, boundNoiseKey: string): PairingStatus {
    const control = controls.get(hostId);
    if (control === undefined) return "offline";
    if (control.noisePublicKey === undefined || control.features?.includes("pairing") !== true) return "host_too_old";
    return control.noisePublicKey === boundNoiseKey ? "available" : "key_mismatch";
  }

  function requestPairing(hostId: string, sessionKey: string, signal: AbortSignal): Promise<PairingRequestResult> {
    const control = controls.get(hostId);
    if (control === undefined) return Promise.resolve({ status: "gone" });
    let perHost = 0;
    let perSession = 0;
    for (const entry of pairingRequests.values()) {
      if (entry.hostId === hostId) perHost += 1;
      if (entry.sessionKey === sessionKey) perSession += 1;
    }
    if (perHost >= MAX_PAIRING_PER_HOST || perSession >= MAX_PAIRING_PER_SESSION) {
      return Promise.resolve({ status: "too_many" });
    }
    return new Promise<PairingRequestResult>((resolve) => {
      const requestId = randomBytes(16).toString("base64url");
      const settle = (result: PairingRequestResult): void => {
        if (!pairingRequests.delete(requestId)) return; // already settled
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const timer = setTimeout(() => settle({ status: "timeout" }), pairingTimeoutMs);
      const abort = (): void => settle({ status: "cancelled" });
      pairingRequests.set(requestId, { control: control.socket, hostId, sessionKey, settle, timer });
      signal.addEventListener("abort", abort, { once: true });
      control.socket.send(encodeRelayFrame({ t: "pairing-request", requestId }));
    });
  }

  const pairing: PairingBroker = { status: pairingStatus, request: requestPairing };

  /**
   * One host's `push` frame (ADR-0025 §4-5): re-checked against the account
   * binding on every send, and the token must be registered under that same
   * account (ADR-0036 §3), then classified back to the asking control.
   * Nothing about the token or the notification reaches the log; the counters
   * keep pushes from crowding the control connections.
   */
  function handlePush(socket: WebSocket, hostId: string, frame: PushFrame): void {
    const startedAt = Date.now();
    const finish = (verdict: PushVerdict): void => {
      console.log(
        JSON.stringify({
          event: "push",
          hostId,
          environment: frame.environment,
          result: verdict.result,
          reason: verdict.reason,
          ms: Date.now() - startedAt,
        }),
      );
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeRelayFrame({ t: "push-result", requestId: frame.requestId, ...verdict }));
      }
    };
    const owner = accounts?.hostOwner(hostId);
    if (accounts === undefined || owner === undefined) {
      finish({ result: "rejected", reason: "unauthorized" });
      return;
    }
    if (apns === undefined || !pushEnvironments.includes(frame.environment)) {
      finish({ result: "unavailable", reason: "environment not configured" });
      return;
    }
    if (accounts.pushTokenOwner(frame.token, frame.environment) !== owner) {
      finish({ result: "rejected", reason: "token_not_registered" });
      return;
    }
    const perHost = pushInflightHosts.get(hostId) ?? 0;
    if (perHost >= pushPerHost || pushInflightTotal >= pushTotal) {
      finish({ result: "retry", reason: "rate_limited" });
      return;
    }
    pushInflightTotal += 1;
    pushInflightHosts.set(hostId, perHost + 1);
    void apns
      .send({ token: frame.token, environment: frame.environment, notification: frame.notification })
      .then((verdict) => {
        // The server's own registration follows APNs too, with the same late-410
        // guard the host applies to its registry.
        if (verdict.result === "unregistered") {
          accounts.forgetPushToken(frame.token, frame.environment, verdict.unregisteredAt);
        }
        finish(verdict);
      }, () => finish({ result: "retry", reason: "server error" }))
      .finally(() => {
        pushInflightTotal -= 1;
        const left = (pushInflightHosts.get(hostId) ?? 1) - 1;
        if (left <= 0) pushInflightHosts.delete(hostId);
        else pushInflightHosts.set(hostId, left);
      });
  }

  /**
   * Handles one join/leave op connection (ADR-0022 §3). The register's Ed25519
   * signature is already verified; this only runs the operation, replies, and
   * hangs up. `noisePublicKey` is present only when a v2 signature bound it.
   */
  function runOp(socket: WebSocket, frame: RegisterFrame, noisePublicKey: string | undefined): void {
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
      if (result.status === "joined") {
        // A re-join can move the host to another account without touching its
        // control connection: asks still pending under the old owner must die
        // before the new binding's invites could reach them.
        for (const request of pairingRequests.values()) {
          if (request.hostId === frame.hostId) request.settle({ status: "gone" });
        }
      }
      answer(result.status === "joined" ? { t: "joined", username: result.username } : { t: "refused", reason: result.reason });
      return;
    }
    if (!accounts.leaveHost(frame.hostId)) {
      answer({ t: "refused", reason: "not_joined" });
      return;
    }
    answer({ t: "left" });
    // The binding is gone, and with it the live control connection's
    // authorization: close it now rather than at its next register.
    controls.get(frame.hostId)?.socket.close(RELAY_CLOSE.hostNotAllowed);
  }

  function onControl(socket: WebSocket): void {
    track(socket);
    const nonce = randomBytes(32).toString("base64url");
    socket.send(encodeRelayFrame({ t: "challenge", nonce }));
    let hostId: string | undefined;
    const deadline = setTimeout(() => socket.close(1008, "register timeout"), registerTimeoutMs);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1008, "unexpected frame");
        return;
      }
      if (hostId !== undefined) {
        // After `registered`, a control may only answer pairing asks — and a
        // reply counts only on the exact socket that carried the request, so
        // a replaced connection can't resolve a new one's pendings. Late or
        // unknown requestIds are ignored; anything else is a violation.
        let answer: HostToRelay;
        try {
          answer = decodeHostToRelay(data.toString());
        } catch {
          socket.close(1008, "malformed frame");
          return;
        }
        if (answer.t === "push") {
          handlePush(socket, hostId, answer);
          return;
        }
        if (answer.t === "name") {
          // Only the host's current control renames it — a frame parsed on a
          // socket mid-replacement (its close handshake still in flight)
          // must not win over the newer connection's identity.
          if (controls.get(hostId)?.socket === socket) accounts?.renameHost(hostId, answer.name);
          return;
        }
        if (answer.t === "pairing" || answer.t === "pairing-refused") {
          const request = pairingRequests.get(answer.requestId);
          if (request === undefined || request.control !== socket) return;
          request.settle(
            answer.t === "pairing"
              ? {
                  status: "ok",
                  secret: answer.secret,
                  expiresAt: answer.expiresAt,
                  ...(answer.endpointSet === undefined ? {} : { endpointSet: answer.endpointSet }),
                }
              : { status: "refused", reason: answer.reason },
          );
          return;
        }
        socket.close(1008, "unexpected frame");
        return;
      }
      let frame: RegisterFrame;
      try {
        const decoded = decodeHostToRelay(data.toString());
        // The only pre-admission frame is register; anything else first is a violation.
        if (decoded.t !== "register") throw new Error("expected register");
        frame = decoded;
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
      // Admission = a host row bound to an account (ADR-0022); a server
      // without accounts admits nobody.
      if (accounts?.hasHost(frame.hostId) !== true) {
        socket.close(RELAY_CLOSE.hostNotAllowed);
        return;
      }
      hostId = frame.hostId;
      clearTimeout(deadline);
      const previous = controls.get(hostId);
      // A second registration wins: a reconnecting host must not be locked out
      // by a zombie control socket from its previous life. The old control's
      // pending pairing asks die with it in its close handler below.
      if (previous !== undefined) previous.socket.close(RELAY_CLOSE.replaced);
      controls.set(hostId, {
        socket,
        ...(noisePublicKey === undefined ? {} : { noisePublicKey }),
        ...(frame.features === undefined ? {} : { features: frame.features }),
      });
      // A bound host's successful register is also its heartbeat for the
      // account: keep last_seen_at fresh so /api/hosts can report online age.
      accounts?.markHostSeen(hostId);
      // The register's name is the host's current one (issue #212); absent
      // means the host predates it and the row keeps what join wrote.
      if (frame.name !== undefined) accounts?.renameHost(hostId, frame.name);
      // Every admitted host is bound, so it always gets the push declaration
      // (ADR-0025 §4) — an empty list means "push-aware, nothing configured",
      // which the host must distinguish from a pre-push server. `features`
      // declares the post-admission frames this build accepts: hosts send
      // `name` only to a connection that lists it.
      socket.send(encodeRelayFrame({ t: "registered", push: pushEnvironments, features: ["name"] }));
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
      // Pairing asks tied to this control die with it — a replaced connection,
      // a leave, or a dropped socket all resolve the waiting HTTP request.
      for (const request of pairingRequests.values()) {
        if (request.control === socket) request.settle({ status: "gone" });
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
      void handleApiRequest(request, response, { accounts, publicOrigin, trustProxy, pairing }).catch(() => {
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
    pairing,
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
      await apns?.close();
    },
  };
}
