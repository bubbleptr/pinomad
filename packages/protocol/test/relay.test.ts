import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  decodeHostToRelay,
  decodeRelayToHost,
  encodeRelayFrame,
  relayChallengeMessage,
  relayHostId,
  signRelayChallenge,
  verifyRelayChallenge,
} from "../src/relay.ts";
import { fromBase64Url, toBase64Url } from "../src/secure-channel.ts";

const ORIGIN = "https://relay.example.com";
const keys = ed25519.keygen();
const hostId = relayHostId(keys.publicKey);
const NONCE = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

const challengeArgs = (overrides?: Partial<{ relayOrigin: string; hostId: string; nonce: string }>) => ({
  relayOrigin: ORIGIN,
  hostId,
  nonce: NONCE,
  ...overrides,
});

describe("relay challenge signatures", () => {
  it("round-trips: sign then verify", () => {
    const signature = signRelayChallenge(keys.secretKey, challengeArgs());
    expect(fromBase64Url(signature)).toHaveLength(64);
    expect(verifyRelayChallenge(signature, challengeArgs())).toBe(true);
  });

  it("rejects a signature over a different nonce", () => {
    const signature = signRelayChallenge(keys.secretKey, challengeArgs({ nonce: toBase64Url(new Uint8Array(32)) }));
    expect(verifyRelayChallenge(signature, challengeArgs())).toBe(false);
  });

  it("rejects a signature over a different relay origin", () => {
    const signature = signRelayChallenge(keys.secretKey, challengeArgs({ relayOrigin: "https://evil.example.com" }));
    expect(verifyRelayChallenge(signature, challengeArgs())).toBe(false);
  });

  it("rejects a signature over a different hostId", () => {
    const other = relayHostId(ed25519.keygen().publicKey);
    const signature = signRelayChallenge(keys.secretKey, challengeArgs({ hostId: other }));
    expect(verifyRelayChallenge(signature, challengeArgs())).toBe(false);
  });

  it("returns false instead of throwing on malformed signatures and hostIds", () => {
    expect(verifyRelayChallenge("!!!", challengeArgs())).toBe(false);
    expect(verifyRelayChallenge("AAAA", challengeArgs())).toBe(false);
    expect(verifyRelayChallenge("", challengeArgs())).toBe(false);
    expect(verifyRelayChallenge(signRelayChallenge(keys.secretKey, challengeArgs()), challengeArgs({ hostId: "!!" }))).toBe(false);
  });

  it("builds the documented message", () => {
    const message = new TextDecoder().decode(relayChallengeMessage(challengeArgs()));
    expect(message).toBe(`pinomad-relay/1\n${ORIGIN}\n${hostId}\n${NONCE}`);
  });
});

describe("relayHostId", () => {
  it("is the base64url of the 32-byte public key", () => {
    expect(hostId).toBe(toBase64Url(keys.publicKey));
    expect(hostId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("throws on a key that is not 32 bytes", () => {
    expect(() => relayHostId(new Uint8Array(31))).toThrow();
  });
});

describe("relay frame codecs", () => {
  it("round-trips every frame shape", () => {
    expect(decodeRelayToHost(encodeRelayFrame({ t: "challenge", nonce: NONCE }))).toEqual({ t: "challenge", nonce: NONCE });
    expect(decodeRelayToHost(encodeRelayFrame({ t: "registered" }))).toEqual({ t: "registered" });
    expect(decodeRelayToHost(encodeRelayFrame({ t: "incoming", connId: "abc" }))).toEqual({ t: "incoming", connId: "abc" });
    const register = { t: "register" as const, hostId, signature: "sig" };
    expect(decodeHostToRelay(encodeRelayFrame(register))).toEqual(register);
  });

  it("rejects malformed relay→host frames", () => {
    for (const text of [
      "nope",
      "{}",
      JSON.stringify({ t: "bogus" }),
      JSON.stringify({ t: "challenge" }),
      JSON.stringify({ t: "challenge", nonce: 1 }),
      JSON.stringify({ t: "incoming" }),
      JSON.stringify([1, 2]),
      "null",
    ]) {
      expect(() => decodeRelayToHost(text), text).toThrow();
    }
  });

  it("rejects malformed host→relay frames", () => {
    for (const text of [
      "nope",
      "{}",
      JSON.stringify({ t: "register" }),
      JSON.stringify({ t: "register", hostId, signature: 5 }),
      JSON.stringify({ t: "challenge", nonce: NONCE }),
      JSON.stringify({ t: "register", hostId: 1, signature: "x" }),
    ]) {
      expect(() => decodeHostToRelay(text), text).toThrow();
    }
  });
});
