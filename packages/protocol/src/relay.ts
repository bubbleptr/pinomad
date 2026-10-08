// Wire format and host authentication for the self-hosted relay (ADR-0008
// phase 2). Host and device both dial out to the relay; after the control
// handshake below, everything the relay forwards is already Noise-encrypted,
// so these frames are the only plaintext it ever sees. Browser-safe: no node:
// imports, no Buffer.

import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64Url, toBase64Url } from "./secure-channel.ts";

// 46xx so relay close codes never collide with the host's own
// (UNAUTHORIZED_CLOSE_CODE = 4401 in frames.ts).
export const RELAY_CLOSE = {
  badSignature: 4601,
  hostNotAllowed: 4603,
  hostOffline: 4604,
  unknownConnection: 4605,
  replaced: 4609,
  acceptTimeout: 4610,
} as const;

/** Relay → host, on the host's control connection. */
export type RelayToHost =
  | { readonly t: "challenge"; readonly nonce: string }
  | { readonly t: "registered" }
  | { readonly t: "incoming"; readonly connId: string };

/** Host → relay: the only frame a control connection may ever send. */
export type HostToRelay = { readonly t: "register"; readonly hostId: string; readonly signature: string };

export function encodeRelayFrame(frame: RelayToHost | HostToRelay): string {
  return JSON.stringify(frame);
}

const isString = (value: unknown): value is string => typeof value === "string";

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("relay frame is not JSON");
  }
}

/** Throws on anything malformed — the relay treats that as a protocol violation. */
export function decodeRelayToHost(text: string): RelayToHost {
  const value = decodeJson(text) as { t?: unknown; nonce?: unknown; connId?: unknown };
  switch (value?.t) {
    case "challenge":
      if (!isString(value.nonce)) throw new Error("malformed challenge");
      return { t: "challenge", nonce: value.nonce };
    case "registered":
      return { t: "registered" };
    case "incoming":
      if (!isString(value.connId)) throw new Error("malformed incoming");
      return { t: "incoming", connId: value.connId };
    default:
      throw new Error("unknown relay frame");
  }
}

/** Throws on anything malformed — the relay closes the control on that. */
export function decodeHostToRelay(text: string): HostToRelay {
  const value = decodeJson(text) as { t?: unknown; hostId?: unknown; signature?: unknown };
  if (value?.t !== "register" || !isString(value.hostId) || !isString(value.signature)) {
    throw new Error("malformed register");
  }
  return { t: "register", hostId: value.hostId, signature: value.signature };
}

/**
 * The hostId is the base64url of the host's 32-byte Ed25519 public key, so the
 * relay needs no lookup table beyond its allowlist. Ed25519 is deliberately
 * separate from the host's Noise X25519 key — no cross-protocol key reuse.
 */
export function relayHostId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return toBase64Url(publicKey);
}

const utf8 = new TextEncoder();

/**
 * The signed message binds the relay's public origin, so a malicious relay
 * cannot forward the challenge to impersonate the host at another relay.
 */
export function relayChallengeMessage(args: { relayOrigin: string; hostId: string; nonce: string }): Uint8Array {
  return utf8.encode(`pinomad-relay/1\n${args.relayOrigin}\n${args.hostId}\n${args.nonce}`);
}

export function signRelayChallenge(
  secretKey: Uint8Array,
  args: { relayOrigin: string; hostId: string; nonce: string },
): string {
  return toBase64Url(ed25519.sign(relayChallengeMessage(args), secretKey));
}

/**
 * Never throws — a bad base64url, a malformed signature, or an undecodable
 * hostId all just mean "not verified". The public key is decoded from hostId.
 */
export function verifyRelayChallenge(
  signature: string,
  args: { relayOrigin: string; hostId: string; nonce: string },
): boolean {
  try {
    return ed25519.verify(fromBase64Url(signature), relayChallengeMessage(args), fromBase64Url(args.hostId));
  } catch {
    return false;
  }
}
