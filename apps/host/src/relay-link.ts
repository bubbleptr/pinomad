// The host side of the self-hosted relay (ADR-0008 phase 2): a persistent
// control connection that proves the host's Ed25519 relay identity, then one
// outbound data socket per `incoming` connId — the relay splices each to a
// device that dialed `/c/<hostId>`. Every accepted socket goes through the
// same IK secure handshake as a LAN socket; the relay only carries ciphertext.

import { randomBytes } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  type ApnsEnvironment,
  decodeRelayToHost,
  encodeRelayFrame,
  type PushFrame,
  type PushVerdict,
  RELAY_CLOSE,
  relayHostId,
  signRelayChallenge,
  signRelayChallengeV2,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { HostValue } from "./host-value.ts";

export type RelayLinkState =
  | { readonly status: "connecting" }
  /**
   * `push` mirrors the server's `registered` declaration: absent on pre-push
   * servers and unbound registrations, an empty list when the server knows
   * push but configures no APNs environment.
   */
  | { readonly status: "registered"; readonly push?: readonly ApnsEnvironment[] }
  | { readonly status: "rejected"; readonly reason: string };

/**
 * The host's answer to the server's `pairing-request` (ADR-0022 §4): a minted
 * account offer, or an early refusal whose reason the API hands back to the
 * asking client. This is only the fast answer — admission is decided again at
 * the IK handshake's commit, so refusals here are hints, not the verdict.
 */
export type AccountOfferResult =
  | {
      readonly ok: true;
      readonly secret: string;
      readonly expiresAt: number;
      /** The same remote candidates a QR invite would carry; the server forwards only. */
      readonly endpointSet?: EndpointSet;
    }
  | { readonly ok: false; readonly reason: string };

export interface RelayLink {
  /** This host's relay identity — what the server binds to an account. */
  readonly hostId: string;
  readonly origin: string;
  state(): RelayLinkState;
  /**
   * Send one push over the live control connection (ADR-0025 §3-4). Resolves
   * to the server's classified verdict; a dead connection, a missing
   * capability, and the 10 s wait all resolve as classified results instead
   * of throwing — the caller maps them to retry/drop.
   */
  sendPush(request: Omit<PushFrame, "t" | "requestId">): Promise<PushVerdict>;
  close(): Promise<void>;
}

/** An http(s) relay origin as the ws(s) base the host dials. */
export function relayWsBase(origin: string): string {
  const normalized = origin.replace(/\/+$/, "");
  if (normalized.startsWith("https://")) return `wss://${normalized.slice("https://".length)}`;
  if (normalized.startsWith("http://")) return `ws://${normalized.slice("http://".length)}`;
  throw new Error(`relay origin must be an http(s) URL: ${origin}`);
}

const REJECTION_REASONS: Record<number, (hostId: string) => string> = {
  [RELAY_CLOSE.badSignature]: () => `the relay rejected this host's registration signature — a version mismatch?`,
  [RELAY_CLOSE.hostNotAllowed]: (hostId) =>
    `the server does not allow this host (${hostId}); join it to an account with \`pinomad join\``,
  [RELAY_CLOSE.replaced]: () => `the relay replaced this control connection — another process registered the same hostId`,
};

/** A push that the server doesn't classify within this window counts as retryable (ADR-0025 §4). */
const PUSH_TIMEOUT_MS = 10_000;

export function startRelayLink(options: {
  /** Public relay origin (https://…); trailing slashes stripped. */
  readonly origin: string;
  readonly signingKey: { readonly secretKey: Uint8Array; readonly publicKey: Uint8Array };
  /** The host's current Noise public key — reported under the v2 signature. */
  readonly noisePublicKey: Uint8Array;
  /** Hand each freshly opened data socket to the gateway's secure handshake. */
  accept(socket: WebSocket): void;
  /**
   * Mints the account-bound offer a `pairing-request` asks for (ADR-0022 §4).
   * Its presence is also the "pairing" feature declaration on register — a
   * link without one refuses any request as `unavailable`, which only a
   * misbehaving server should ever send (feature-gated servers don't ask).
   */
  accountOffer?(): Promise<AccountOfferResult>;
  /**
   * The host's current display name (issue #212): every register carries it,
   * and renames ride a `name` frame on connections whose `registered`
   * declared the "name" feature. Undefined means "don't report" — the
   * register then omits the field like a pre-5.12 host.
   */
  hostName?: HostValue<string | undefined>;
  /**
   * Fires only when the state actually changes: a different `status`, or a
   * `rejected` with a different `reason` (the same rejection on retry doesn't
   * fire again). The initial `connecting` state doesn't fire.
   */
  onStateChange?(state: RelayLinkState): void;
  readonly reconnectDelayMs?: { readonly min: number; readonly max: number };
  readonly pingIntervalMs?: number;
  readonly maxPendingAccepts?: number;
}): RelayLink {
  const origin = options.origin.replace(/\/+$/, "");
  const wsBase = relayWsBase(origin);
  const hostId = relayHostId(options.signingKey.publicKey);
  const minDelay = options.reconnectDelayMs?.min ?? 1_000;
  const maxDelay = options.reconnectDelayMs?.max ?? 30_000;
  const maxPendingAccepts = options.maxPendingAccepts ?? 16;

  let state: RelayLinkState = { status: "connecting" };
  let stopped = false;
  let control: WebSocket | undefined;
  let delay = minDelay;
  let retryTimer: NodeJS.Timeout | undefined;
  let pendingAccepts = 0;
  // What the current control connection declared at `registered`. Cleared the
  // moment the socket dies or a new one starts connecting — the capability is
  // per-connection, so a stale declaration must never survive a reconnect.
  let pushEnvironments: readonly ApnsEnvironment[] | undefined;
  // Per-connection name reporting (issue #212): `reportedName` is what this
  // control last carried — its register's name first, then each `name`
  // frame — and `nameDeclared` is its `registered` declaration. Both die with
  // the connection like `pushEnvironments`: a stale declaration must never
  // survive a reconnect.
  let reportedName: string | undefined;
  let nameDeclared = false;
  // Push requests bound to the control that sent them (ADR-0025 §4): a close
  // settles every one as retry, and a result that arrives late finds no entry.
  const pushes = new Map<string, { readonly socket: WebSocket; readonly settle: (verdict: PushVerdict) => void }>();

  // Every state assignment goes through here so observers see each real
  // transition exactly once — reconnecting while already `connecting`, or the
  // same rejection reason on retry, is not news.
  function setState(next: RelayLinkState): void {
    const changed =
      state.status !== next.status ||
      (state.status === "rejected" && next.status === "rejected" && state.reason !== next.reason);
    state = next;
    if (changed) options.onStateChange?.(next);
  }

  // Liveness for control and data sockets alike: a dead relay must not leave
  // half-open GatewayClients on sockets that will never see another byte.
  const watched = new Set<WebSocket>();
  const ponged = new WeakMap<WebSocket, boolean>();
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const pingTimer = setInterval(() => {
    for (const socket of watched) {
      // ws ping() throws on a CONNECTING socket; those are bounded by
      // handshakeTimeout instead — a socket must open within one interval.
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (ponged.get(socket) === true) {
        ponged.set(socket, false);
        socket.ping();
      } else {
        socket.terminate();
      }
    }
  }, pingIntervalMs);

  function watch(socket: WebSocket): void {
    watched.add(socket);
    // Alive until the first ping proves otherwise.
    ponged.set(socket, true);
    socket.on("pong", () => ponged.set(socket, true));
    socket.once("close", () => watched.delete(socket));
    socket.on("error", () => socket.terminate());
  }

  function connectControl(): void {
    if (stopped) return;
    const socket = new WebSocket(`${wsBase}/host`, { handshakeTimeout: pingIntervalMs });
    control = socket;
    pushEnvironments = undefined;
    nameDeclared = false;
    reportedName = undefined;
    watch(socket);
    // Attached synchronously on purpose: the relay sends `challenge` the
    // instant the upgrade completes — waiting for `open` loses it.
    // The socket is passed in: a pairing answer completes asynchronously and
    // must go out on the connection that asked, not whatever `control` is then.
    socket.on("message", (data, isBinary) => onControlMessage(socket, data, isBinary));
    socket.once("close", (code) => onControlClosed(socket, code));
  }

  function reconnect(at: number): void {
    if (stopped || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connectControl();
    }, at);
  }

  function onControlMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    let frame: RelayToHost;
    try {
      if (isBinary) throw new Error("binary control frame");
      frame = decodeRelayToHost(data.toString());
    } catch {
      // A malformed control frame means the peer is not our relay; drop and retry.
      socket.close();
      return;
    }
    switch (frame.t) {
      case "challenge": {
        // Both signatures: a pre-accounts server verifies v1 and ignores the
        // rest; an account server prefers v2, which also binds the Noise key.
        const noisePublicKey = toBase64Url(options.noisePublicKey);
        const challenge = { relayOrigin: origin, hostId, nonce: frame.nonce };
        reportedName = options.hostName?.value;
        socket.send(
          encodeRelayFrame({
            t: "register",
            hostId,
            signature: signRelayChallenge(options.signingKey.secretKey, challenge),
            signatureV2: signRelayChallengeV2(options.signingKey.secretKey, { ...challenge, noisePublicKey }),
            noisePublicKey,
            // Capability negotiation (ADR-0022 §4): feature-gated requests
            // would crash an old host's decoder, so the server only sends
            // them to controls that declared "pairing".
            ...(options.accountOffer === undefined ? {} : { features: ["pairing"] }),
            ...(reportedName === undefined ? {} : { name: reportedName }),
          }),
        );
        break;
      }
      case "registered": {
        delay = minDelay;
        pushEnvironments = frame.push;
        nameDeclared = frame.features?.includes("name") === true;
        // A rename inside the register → registered window left reportedName
        // stale: top it up now that the capability is known (issue #212).
        const current = options.hostName?.value;
        if (nameDeclared && current !== undefined && current !== reportedName) {
          reportedName = current;
          socket.send(encodeRelayFrame({ t: "name", name: current }));
        }
        // The declaration rides the state so the one `registered` log line
        // per connection says what this instance can push — "pre-push
        // server" and "no keys configured" are different stories.
        setState({ status: "registered", ...(frame.push === undefined ? {} : { push: frame.push }) });
        break;
      }
      case "push-result": {
        const request = pushes.get(frame.requestId);
        // Results count only on the control that asked — a reply over a
        // replaced connection must not settle a new one's request.
        if (request === undefined || request.socket !== socket) break;
        pushes.delete(frame.requestId);
        const { t: _t, requestId: _id, ...verdict } = frame;
        request.settle(verdict);
        break;
      }
      case "pairing-request": {
        const accountOffer = options.accountOffer;
        const refused = (reason: string): void => {
          socket.send(encodeRelayFrame({ t: "pairing-refused", requestId: frame.requestId, reason }));
        };
        if (accountOffer === undefined) {
          refused("unavailable");
          break;
        }
        void accountOffer().then(
          (result) => {
            // The answer is worthless off the asking connection: a replaced or
            // dead control means the server already dropped the request.
            if (socket !== control || socket.readyState !== WebSocket.OPEN) return;
            socket.send(
              encodeRelayFrame(
                result.ok
                  ? {
                      t: "pairing",
                      requestId: frame.requestId,
                      secret: result.secret,
                      expiresAt: result.expiresAt,
                      ...(result.endpointSet === undefined ? {} : { endpointSet: result.endpointSet }),
                    }
                  : { t: "pairing-refused", requestId: frame.requestId, reason: result.reason },
              ),
            );
          },
          () => {
            if (socket === control && socket.readyState === WebSocket.OPEN) refused("error");
          },
        );
        break;
      }
      case "incoming": {
        // Past the cap the device just times out at the relay (4610) — the
        // host keeps its accept budget instead of hoarding dying sockets.
        if (pendingAccepts >= maxPendingAccepts) break;
        pendingAccepts += 1;
        const data = new WebSocket(`${wsBase}/accept/${frame.connId}`, { handshakeTimeout: pingIntervalMs });
        watch(data);
        // "Pending" approximation: until the socket closes or 10 s pass — by
        // then a live handshake has long settled or the socket is dead anyway.
        const release = (): void => {
          pendingAccepts -= 1;
          clearTimeout(ageOut);
          data.off("close", release);
        };
        const ageOut = setTimeout(release, 10_000);
        data.once("close", release);
        options.accept(data);
        break;
      }
    }
  }

  function onControlClosed(socket: WebSocket, code: number): void {
    control = undefined;
    pushEnvironments = undefined;
    nameDeclared = false;
    reportedName = undefined;
    // Everything in flight settles as retry: the request dies with its
    // connection, and any push-result that still arrives is ignored (ADR-0025 §4).
    for (const [requestId, request] of pushes) {
      if (request.socket === socket) {
        pushes.delete(requestId);
        request.settle({ result: "retry", reason: "control closed" });
      }
    }
    if (stopped) return;
    const rejection = REJECTION_REASONS[code];
    if (rejection !== undefined) {
      const reason = `relay ${origin}: ${rejection(hostId)} (${code})`;
      setState({ status: "rejected", reason });
      delay = maxDelay;
      reconnect(maxDelay);
      return;
    }
    setState({ status: "connecting" });
    reconnect(delay);
    delay = Math.min(maxDelay, delay * 2);
  }

  // Renames ride the live control only: an undeclared connection (a server
  // that predates "name") never sees the frame — its next register simply
  // carries the newer name instead.
  const detachName = options.hostName?.subscribe((name) => {
    if (name === undefined || name === reportedName) return;
    const socket = control;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || !nameDeclared) return;
    reportedName = name;
    socket.send(encodeRelayFrame({ t: "name", name }));
  });

  connectControl();

  return {
    hostId,
    origin,
    state: () => state,
    sendPush(request) {
      const socket = control;
      if (stopped || socket === undefined || socket.readyState !== WebSocket.OPEN || state.status !== "registered") {
        return Promise.resolve({ result: "retry", reason: "control disconnected" });
      }
      const envs = pushEnvironments;
      // The capability is the server's word on this connection: nothing
      // declared (a pre-push server, or an unbound registration) and a
      // declared list missing this environment are both permanent for this
      // connection — unavailable, and the frame must never reach the peer
      // (ADR-0025 §3).
      if (envs === undefined) {
        return Promise.resolve({ result: "unavailable", reason: "server does not declare push" });
      }
      if (!envs.includes(request.environment)) {
        return Promise.resolve({ result: "unavailable", reason: `environment ${request.environment} not declared` });
      }
      return new Promise<PushVerdict>((resolve) => {
        const requestId = randomBytes(16).toString("base64url");
        const timer = setTimeout(() => {
          if (pushes.delete(requestId)) resolve({ result: "retry", reason: "timeout" });
        }, PUSH_TIMEOUT_MS);
        pushes.set(requestId, {
          socket,
          settle: (verdict) => {
            clearTimeout(timer);
            resolve(verdict);
          },
        });
        socket.send(encodeRelayFrame({ t: "push", requestId, ...request }));
      });
    },
    close() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearInterval(pingTimer);
      detachName?.();
      // Terminating fires each socket's close, which disposes its GatewayClient.
      for (const socket of watched) socket.terminate();
      return Promise.resolve();
    },
  };
}
