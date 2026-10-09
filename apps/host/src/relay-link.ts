// The host side of the self-hosted relay (ADR-0008 phase 2): a persistent
// control connection that proves the host's Ed25519 relay identity, then one
// outbound data socket per `incoming` connId — the relay splices each to a
// device that dialed `/c/<hostId>`. Every accepted socket goes through the
// same IK secure handshake as a LAN socket; the relay only carries ciphertext.

import { WebSocket, type RawData } from "ws";
import {
  decodeRelayToHost,
  encodeRelayFrame,
  RELAY_CLOSE,
  relayHostId,
  signRelayChallenge,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";

export type RelayLinkState =
  | { readonly status: "connecting" }
  | { readonly status: "registered" }
  | { readonly status: "rejected"; readonly reason: string };

export interface RelayLink {
  /** This host's relay identity — what goes in the relay's `--allow-host`. */
  readonly hostId: string;
  readonly origin: string;
  state(): RelayLinkState;
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
    `the relay does not allow this host; add --allow-host ${hostId} to the relay's arguments`,
  [RELAY_CLOSE.replaced]: () => `the relay replaced this control connection — another process registered the same hostId`,
};

export function startRelayLink(options: {
  /** Public relay origin (https://…); trailing slashes stripped. */
  readonly origin: string;
  readonly signingKey: { readonly secretKey: Uint8Array; readonly publicKey: Uint8Array };
  /** Hand each freshly opened data socket to the gateway's secure handshake. */
  accept(socket: WebSocket): void;
  onRejected?(reason: string): void;
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
    watch(socket);
    // Attached synchronously on purpose: the relay sends `challenge` the
    // instant the upgrade completes — waiting for `open` loses it.
    socket.on("message", onControlMessage);
    socket.once("close", onControlClosed);
  }

  function reconnect(at: number): void {
    if (stopped || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connectControl();
    }, at);
  }

  function onControlMessage(data: RawData, isBinary: boolean): void {
    let frame: RelayToHost;
    try {
      if (isBinary) throw new Error("binary control frame");
      frame = decodeRelayToHost(data.toString());
    } catch {
      // A malformed control frame means the peer is not our relay; drop and retry.
      control?.close();
      return;
    }
    switch (frame.t) {
      case "challenge":
        control?.send(
          encodeRelayFrame({
            t: "register",
            hostId,
            signature: signRelayChallenge(options.signingKey.secretKey, { relayOrigin: origin, hostId, nonce: frame.nonce }),
          }),
        );
        break;
      case "registered":
        delay = minDelay;
        state = { status: "registered" };
        break;
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

  function onControlClosed(code: number): void {
    control = undefined;
    if (stopped) return;
    const rejection = REJECTION_REASONS[code];
    if (rejection !== undefined) {
      const reason = `relay ${origin}: ${rejection(hostId)} (${code})`;
      // Fire onRejected once per distinct rejection, not every 30 s retry.
      if (state.status !== "rejected" || state.reason !== reason) options.onRejected?.(reason);
      state = { status: "rejected", reason };
      delay = maxDelay;
      reconnect(maxDelay);
      return;
    }
    state = { status: "connecting" };
    reconnect(delay);
    delay = Math.min(maxDelay, delay * 2);
  }

  connectControl();

  return {
    hostId,
    origin,
    state: () => state,
    close() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearInterval(pingTimer);
      // Terminating fires each socket's close, which disposes its GatewayClient.
      for (const socket of watched) socket.terminate();
      return Promise.resolve();
    },
  };
}
