import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  decodeHostToRelay,
  decodeRelayToHost,
  encodeRelayFrame,
  relayChallengeMessage,
  relayChallengeMessageV2,
  relayHostId,
  signRelayChallenge,
  signRelayChallengeV2,
  verifyRelayChallenge,
  verifyRelayChallengeV2,
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

describe("relay challenge signatures v2", () => {
  const noisePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const v2Args = (overrides?: Partial<{ relayOrigin: string; hostId: string; nonce: string; noisePublicKey: string }>) => ({
    ...challengeArgs(),
    noisePublicKey,
    ...overrides,
  });

  it("round-trips and binds the Noise public key", () => {
    const signature = signRelayChallengeV2(keys.secretKey, v2Args());
    expect(verifyRelayChallengeV2(signature, v2Args())).toBe(true);
    // The key is inside the signed message: reporting another key fails.
    const other = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    expect(verifyRelayChallengeV2(signature, v2Args({ noisePublicKey: other })).valueOf()).toBe(false);
  });

  it("rejects a v2 signature under the v1 message and vice versa", () => {
    const v2 = signRelayChallengeV2(keys.secretKey, v2Args());
    expect(verifyRelayChallenge(v2, challengeArgs())).toBe(false);
    const v1 = signRelayChallenge(keys.secretKey, challengeArgs());
    expect(verifyRelayChallengeV2(v1, v2Args())).toBe(false);
  });

  it("builds the documented v2 message", () => {
    const message = new TextDecoder().decode(relayChallengeMessageV2(v2Args()));
    expect(message).toBe(`pinomad-relay/2\n${ORIGIN}\n${hostId}\n${NONCE}\n${noisePublicKey}`);
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

  it("round-trips the account-operation frames", () => {
    expect(decodeRelayToHost(encodeRelayFrame({ t: "joined", username: "kieran" }))).toEqual({
      t: "joined",
      username: "kieran",
    });
    expect(decodeRelayToHost(encodeRelayFrame({ t: "left" }))).toEqual({ t: "left" });
    expect(decodeRelayToHost(encodeRelayFrame({ t: "refused", reason: "invalid_token" }))).toEqual({
      t: "refused",
      reason: "invalid_token",
    });
    const opRegister = {
      t: "register" as const,
      hostId,
      signature: "v1",
      signatureV2: "v2",
      noisePublicKey: "noise",
      op: "join" as const,
      joinToken: "tok",
      name: "omarchy",
      features: ["pairing"],
    };
    expect(decodeHostToRelay(encodeRelayFrame(opRegister))).toEqual(opRegister);
  });

  it("keeps a bare register minimal and rejects malformed optional fields", () => {
    // Optional fields are absent from the decoded frame, not undefined-valued.
    expect(decodeHostToRelay(JSON.stringify({ t: "register", hostId, signature: "s" }))).toEqual({
      t: "register",
      hostId,
      signature: "s",
    });
    for (const frame of [
      { t: "register", hostId, signature: "s", op: "bogus" },
      { t: "register", hostId, signature: "s", signatureV2: 3 },
      { t: "register", hostId, signature: "s", noisePublicKey: null },
      { t: "register", hostId, signature: "s", joinToken: [] },
      { t: "register", hostId, signature: "s", features: "pairing" },
      { t: "register", hostId, signature: "s", features: [1] },
      { t: "register", hostId, signature: "s", features: Array.from({ length: 17 }, () => "x") },
    ]) {
      expect(() => decodeHostToRelay(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
    // An old server's decoder ignores fields it doesn't know — the new fields
    // must never make a v1 register unreadable.
    const legacy = JSON.parse(encodeRelayFrame({ t: "register", hostId, signature: "s", op: "join", joinToken: "t" })) as {
      t: string;
      hostId: string;
      signature: string;
    };
    expect({ t: legacy.t, hostId: legacy.hostId, signature: legacy.signature }).toEqual({
      t: "register",
      hostId,
      signature: "s",
    });
  });

  it("rejects malformed joined/refused frames", () => {
    for (const text of [
      JSON.stringify({ t: "joined" }),
      JSON.stringify({ t: "joined", username: 1 }),
      JSON.stringify({ t: "refused" }),
      JSON.stringify({ t: "refused", reason: {} }),
    ]) {
      expect(() => decodeRelayToHost(text), text).toThrow();
    }
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
