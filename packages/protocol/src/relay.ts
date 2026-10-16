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
  | { readonly t: "incoming"; readonly connId: string }
  /**
   * The server asks the host to mint a one-time pairing offer for a device it
   * is vouching (ADR-0022 §4). Sent only to controls that declared the
   * "pairing" feature — older hosts' decoders throw on unknown frames.
   */
  | { readonly t: "pairing-request"; readonly requestId: string }
  // One-shot account operations (ADR-0022 §3): the server answers an op
  // connection's register with one of these, then closes it.
  | { readonly t: "joined"; readonly username: string }
  | { readonly t: "left" }
  | { readonly t: "refused"; readonly reason: string };

/**
 * Host → relay: `register` is the first and only pre-admission frame; after
 * `registered`, the control connection may answer pairing requests.
 * `signature` stays mandatory — a pre-accounts server verifies only it and
 * ignores everything else (roadmap M3: new host + old server must still work).
 */
export type HostToRelay = RegisterFrame | PairingAnswerFrame;

export interface RegisterFrame {
  readonly t: "register";
  readonly hostId: string;
  readonly signature: string;
  /**
   * `pinomad-relay/2` signature that additionally binds `noisePublicKey`.
   * Account-mode servers verify this over the v1 signature when present.
   */
  readonly signatureV2?: string;
  /** The host's current Noise public key; trusted only when `signatureV2` verifies. */
  readonly noisePublicKey?: string;
  /** Set on one-shot join/leave connections — they never become control connections. */
  readonly op?: "join" | "leave";
  /** The single-use token join spends (ADR-0022 §3). Never logged server-side. */
  readonly joinToken?: string;
  /** Display name stored on the hosts row at join. */
  readonly name?: string;
  /** Capability strings the pairing step (M3 item 4) gates on, e.g. "pairing". */
  readonly features?: readonly string[];
}

/**
 * The host's answer to a `pairing-request` (ADR-0022 §4): the minted offer's
 * secret, or a refusal reason the API hands back to the asking client. Early
 * refusal is only a fast, readable error — admission is decided again at the
 * IK handshake's commit.
 */
export type PairingAnswerFrame =
  | { readonly t: "pairing"; readonly requestId: string; readonly secret: string; readonly expiresAt: number }
  | { readonly t: "pairing-refused"; readonly requestId: string; readonly reason: string };

export function encodeRelayFrame(frame: RelayToHost | HostToRelay): string {
  return JSON.stringify(frame);
}

const isString = (value: unknown): value is string => typeof value === "string";

// requestIds, secrets, and reasons are all small protocol-controlled strings;
// bounding them keeps a hostile peer from making the peer store novels.
const isBoundedString = (value: unknown, max = 64): value is string =>
  isString(value) && value.length > 0 && value.length <= max;

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("relay frame is not JSON");
  }
}

/** Throws on anything malformed — the relay treats that as a protocol violation. */
export function decodeRelayToHost(text: string): RelayToHost {
  const value = decodeJson(text) as {
    t?: unknown;
    nonce?: unknown;
    connId?: unknown;
    requestId?: unknown;
    username?: unknown;
    reason?: unknown;
  };
  switch (value?.t) {
    case "challenge":
      if (!isString(value.nonce)) throw new Error("malformed challenge");
      return { t: "challenge", nonce: value.nonce };
    case "registered":
      return { t: "registered" };
    case "incoming":
      if (!isString(value.connId)) throw new Error("malformed incoming");
      return { t: "incoming", connId: value.connId };
    case "pairing-request":
      if (!isBoundedString(value.requestId)) throw new Error("malformed pairing-request");
      return { t: "pairing-request", requestId: value.requestId };
    case "joined":
      if (!isString(value.username)) throw new Error("malformed joined");
      return { t: "joined", username: value.username };
    case "left":
      return { t: "left" };
    case "refused":
      if (!isString(value.reason)) throw new Error("malformed refused");
      return { t: "refused", reason: value.reason };
    default:
      throw new Error("unknown relay frame");
  }
}

/** Throws on anything malformed — the relay closes the control on that. */
export function decodeHostToRelay(text: string): HostToRelay {
  const value = decodeJson(text) as {
    t?: unknown;
    hostId?: unknown;
    signature?: unknown;
    signatureV2?: unknown;
    noisePublicKey?: unknown;
    op?: unknown;
    joinToken?: unknown;
    name?: unknown;
    features?: unknown;
    requestId?: unknown;
    secret?: unknown;
    expiresAt?: unknown;
    reason?: unknown;
  };
  switch (value?.t) {
    case "register":
      return decodeRegister(value);
    case "pairing":
      if (
        !isBoundedString(value.requestId) ||
        !isBoundedString(value.secret) ||
        typeof value.expiresAt !== "number" ||
        !Number.isFinite(value.expiresAt)
      ) {
        throw new Error("malformed pairing");
      }
      return { t: "pairing", requestId: value.requestId, secret: value.secret, expiresAt: value.expiresAt };
    case "pairing-refused":
      if (!isBoundedString(value.requestId) || !isBoundedString(value.reason)) {
        throw new Error("malformed pairing-refused");
      }
      return { t: "pairing-refused", requestId: value.requestId, reason: value.reason };
    default:
      throw new Error("unknown host frame");
    }
}

function decodeRegister(value: {
  t?: unknown;
  hostId?: unknown;
  signature?: unknown;
  signatureV2?: unknown;
  noisePublicKey?: unknown;
  op?: unknown;
  joinToken?: unknown;
  name?: unknown;
  features?: unknown;
}): RegisterFrame {
  if (value.t !== "register" || !isString(value.hostId) || !isString(value.signature)) {
    throw new Error("malformed register");
  }
  if (value.op !== undefined && value.op !== "join" && value.op !== "leave") throw new Error("malformed register");
  if (value.signatureV2 !== undefined && !isString(value.signatureV2)) throw new Error("malformed register");
  if (value.noisePublicKey !== undefined && !isString(value.noisePublicKey)) throw new Error("malformed register");
  if (value.joinToken !== undefined && !isString(value.joinToken)) throw new Error("malformed register");
  if (value.name !== undefined && !isString(value.name)) throw new Error("malformed register");
  if (
    value.features !== undefined &&
    (!Array.isArray(value.features) ||
      value.features.length > 16 ||
      !value.features.every((feature) => isString(feature) && feature.length <= 64))
  ) {
    throw new Error("malformed register");
  }
  return {
    t: "register",
    hostId: value.hostId,
    signature: value.signature,
    ...(value.signatureV2 === undefined ? {} : { signatureV2: value.signatureV2 }),
    ...(value.noisePublicKey === undefined ? {} : { noisePublicKey: value.noisePublicKey }),
    ...(value.op === undefined ? {} : { op: value.op }),
    ...(value.joinToken === undefined ? {} : { joinToken: value.joinToken }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.features === undefined ? {} : { features: value.features }),
  };
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

/**
 * `pinomad-relay/2` (ADR-0022 §3): same challenge plus the host's current Noise
 * public key, so the server can trust the key a register reports — a relay that
 * rewrote the plaintext field would break the signature.
 */
export function relayChallengeMessageV2(args: {
  relayOrigin: string;
  hostId: string;
  nonce: string;
  noisePublicKey: string;
}): Uint8Array {
  return utf8.encode(
    `pinomad-relay/2\n${args.relayOrigin}\n${args.hostId}\n${args.nonce}\n${args.noisePublicKey}`,
  );
}

export function signRelayChallengeV2(
  secretKey: Uint8Array,
  args: { relayOrigin: string; hostId: string; nonce: string; noisePublicKey: string },
): string {
  return toBase64Url(ed25519.sign(relayChallengeMessageV2(args), secretKey));
}

export function verifyRelayChallengeV2(
  signature: string,
  args: { relayOrigin: string; hostId: string; nonce: string; noisePublicKey: string },
): boolean {
  try {
    return ed25519.verify(fromBase64Url(signature), relayChallengeMessageV2(args), fromBase64Url(args.hostId));
  } catch {
    return false;
  }
}
