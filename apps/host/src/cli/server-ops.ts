// One-shot account operations against the server (ADR-0022 §3), used by
// `pinomad join`/`pinomad leave`: probe whether the server runs accounts, then
// a single /host connection that answers the challenge with an op register,
// takes one reply frame, and hangs up. Kept apart from relay-link.ts — that
// one owns the persistent control connection with reconnects.
import { WebSocket } from "ws";
import {
  decodeRelayToHost,
  encodeRelayFrame,
  RELAY_CLOSE,
  relayHostId,
  signRelayChallenge,
  signRelayChallengeV2,
  type RelayToHost,
} from "@pinomad/protocol/relay.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { relayWsBase } from "../relay-link.ts";

export type ServerProbe = "enabled" | "disabled" | "unreachable";

/**
 * Account operations are TLS-only (ADR-0022): a plaintext ws:// join would hand
 * the one-use token to anyone on the path — the challenge signature proves the
 * host key but authenticates nothing about the server. Loopback http stays for
 * local development.
 */
export function assertSecureServerOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`not a URL: ${origin}`);
  }
  const host = url.hostname;
  const loopback = host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "::1" || host === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return;
  throw new Error(`account operations need an https origin (loopback http allowed for development) — got ${origin}`);
}

/**
 * Whether the origin runs server accounts. `enabled` needs the account API's
 * own answer (401 unauthenticated, or a JSON user); a 404 (`accounts_disabled`,
 * or an old server with no /api at all) or an SPA page mean "no accounts".
 * Anything else — 502 through the proxy, a WAF's 403 — is "unreachable": we
 * can't tell, so leave must not mistake it for a clean unbind.
 */
export async function probeServerAccounts(origin: string, fetchImpl: typeof fetch = fetch): Promise<ServerProbe> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/me`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return "unreachable";
  }
  if (response.status === 401) return "enabled";
  if (response.status === 200) {
    const body = (await response.json().catch(() => undefined)) as { user?: unknown } | undefined;
    return typeof body?.user === "object" && body.user !== null ? "enabled" : "disabled";
  }
  return response.status === 404 ? "disabled" : "unreachable";
}

export type ServerOpResult =
  | { readonly t: "joined"; readonly username: string }
  | { readonly t: "left" }
  | { readonly t: "refused"; readonly reason: string };

const closeReason = (code: number, origin: string): string => {
  switch (code) {
    case RELAY_CLOSE.badSignature:
      return `the server rejected this host's registration signature (${code})`;
    // An old server knows nothing of `op` and fails its admission check; a new
    // one never closes an op connection with 4603.
    case RELAY_CLOSE.hostNotAllowed:
      return `the server does not know this host (${code}) — a pre-accounts server can't do join/leave; upgrade it first`;
    default:
      return `the connection to ${origin} closed (${code})`;
  }
};

/**
 * Runs one join/leave operation: connect /host, answer the challenge with a
 * register carrying `op`, resolve with the reply frame. The server closes the
 * socket right after answering; a close before the reply is a failure.
 */
export async function runServerOperation(options: {
  readonly origin: string;
  readonly signingKey: { readonly secretKey: Uint8Array; readonly publicKey: Uint8Array };
  /** The host's current X25519 Noise public key — v2 binds it into the register. */
  readonly noisePublicKey: Uint8Array;
  readonly op: "join" | "leave";
  readonly joinToken?: string;
  readonly name?: string;
  readonly timeoutMs?: number;
}): Promise<ServerOpResult> {
  const origin = options.origin.replace(/\/+$/, "");
  assertSecureServerOrigin(origin);
  const hostId = relayHostId(options.signingKey.publicKey);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const socket = new WebSocket(`${relayWsBase(origin)}/host`, { handshakeTimeout: timeoutMs });
  return await new Promise((resolve, reject) => {
    const finish = (done: () => void): void => {
      clearTimeout(timer);
      socket.close();
      done();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`no answer from ${origin} within ${timeoutMs / 1000}s`))), timeoutMs);
    // `error` is always followed by `close`, which produces the rejection.
    socket.once("error", () => {});
    socket.once("close", (code) => finish(() => reject(new Error(closeReason(code, origin)))));
    // Listeners attach before `open`: the challenge arrives during the upgrade.
    socket.on("message", (data, isBinary) => {
      let frame: RelayToHost;
      try {
        if (isBinary) throw new Error("binary frame");
        frame = decodeRelayToHost(data.toString());
      } catch {
        finish(() => reject(new Error(`${origin} is not speaking the pinomad relay protocol`)));
        return;
      }
      if (frame.t === "challenge") {
        const noisePublicKey = toBase64Url(options.noisePublicKey);
        const challenge = { relayOrigin: origin, hostId, nonce: frame.nonce };
        socket.send(
          encodeRelayFrame({
            t: "register",
            hostId,
            signature: signRelayChallenge(options.signingKey.secretKey, challenge),
            signatureV2: signRelayChallengeV2(options.signingKey.secretKey, { ...challenge, noisePublicKey }),
            noisePublicKey,
            op: options.op,
            ...(options.joinToken === undefined ? {} : { joinToken: options.joinToken }),
            ...(options.name === undefined ? {} : { name: options.name }),
          }),
        );
        return;
      }
      // A server old enough to ignore `op` treats this as a plain register and
      // answers `registered` — that's the "too old" signal, not success.
      if (frame.t === "registered") {
        finish(() => reject(new Error(`${origin} ignored the operation — the server is too old for accounts; upgrade it first`)));
        return;
      }
      if (frame.t === "incoming") return; // never sent to an op connection
      finish(() => resolve(frame));
    });
  });
}
