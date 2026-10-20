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

  it("round-trips the pairing frames", () => {
    expect(decodeRelayToHost(encodeRelayFrame({ t: "pairing-request", requestId: "req-1" }))).toEqual({
      t: "pairing-request",
      requestId: "req-1",
    });
    expect(
      decodeHostToRelay(encodeRelayFrame({ t: "pairing", requestId: "req-1", secret: "sec", expiresAt: 123 })),
    ).toEqual({ t: "pairing", requestId: "req-1", secret: "sec", expiresAt: 123 });
    expect(decodeHostToRelay(encodeRelayFrame({ t: "pairing-refused", requestId: "req-1", reason: "disabled" }))).toEqual({
      t: "pairing-refused",
      requestId: "req-1",
      reason: "disabled",
    });
  });

  it("rejects malformed pairing frames", () => {
    for (const text of [
      JSON.stringify({ t: "pairing-request" }),
      JSON.stringify({ t: "pairing-request", requestId: 1 }),
      JSON.stringify({ t: "pairing-request", requestId: "x".repeat(65) }),
    ]) {
      expect(() => decodeRelayToHost(text), text).toThrow();
    }
    for (const text of [
      JSON.stringify({ t: "pairing" }),
      JSON.stringify({ t: "pairing", requestId: "r" }),
      JSON.stringify({ t: "pairing", requestId: "r", secret: "s" }),
      JSON.stringify({ t: "pairing", requestId: "r", secret: "s", expiresAt: "soon" }),
      JSON.stringify({ t: "pairing", requestId: "r", secret: "s", expiresAt: Number.NaN }),
      JSON.stringify({ t: "pairing-refused" }),
      JSON.stringify({ t: "pairing-refused", requestId: "r" }),
      JSON.stringify({ t: "pairing-refused", requestId: "r", reason: 5 }),
      // Register fields don't rescue a pairing frame: it needs its own.
      JSON.stringify({ t: "pairing", hostId, signature: "s" }),
    ]) {
      expect(() => decodeHostToRelay(text), text).toThrow();
    }
  });

  it("round-trips the push frames (ADR-0025 §3)", () => {
    const push = {
      t: "push" as const,
      requestId: "req-1",
      token: "aa".repeat(32),
      environment: "production" as const,
      notification: {
        title: "PiNomad conversation",
        body: "Waiting for your answer",
        collapseId: "ab".repeat(16),
        hostKey: "host-key",
        conversationId: 7,
      },
    };
    expect(decodeHostToRelay(encodeRelayFrame(push))).toEqual(push);

    for (const result of [
      { t: "push-result" as const, requestId: "req-1", result: "accepted" as const, reason: "ok" },
      {
        t: "push-result" as const,
        requestId: "req-1",
        result: "unregistered" as const,
        reason: "Unregistered",
        unregisteredAt: 1234,
      },
      { t: "push-result" as const, requestId: "req-1", result: "retry" as const, reason: "TooManyRequests" },
      {
        t: "push-result" as const,
        requestId: "req-1",
        result: "retry" as const,
        reason: "InternalServerError",
        retryAfterMs: 900_000,
      },
      { t: "push-result" as const, requestId: "req-1", result: "rejected" as const, reason: "BadDeviceToken" },
      { t: "push-result" as const, requestId: "req-1", result: "unavailable" as const, reason: "not configured" },
    ]) {
      expect(decodeRelayToHost(encodeRelayFrame(result))).toEqual(result);
    }
  });

  it("round-trips the name frame and registered's features declaration", () => {
    expect(decodeHostToRelay(encodeRelayFrame({ t: "name", name: "omarchy" }))).toEqual({ t: "name", name: "omarchy" });
    expect(decodeRelayToHost(encodeRelayFrame({ t: "registered", features: ["name", "future-feature"] }))).toEqual({
      t: "registered",
      features: ["name", "future-feature"],
    });
    // A peer that doesn't know `features` — the old-host shape — still
    // decodes the frame: unknown fields were always ignored.
    expect(decodeRelayToHost(JSON.stringify({ t: "registered", unknownField: [1, 2] }))).toEqual({ t: "registered" });
  });

  it("rejects malformed name frames and malformed features declarations", () => {
    for (const frame of [
      { t: "name" },
      { t: "name", name: "" },
      { t: "name", name: 3 },
      { t: "name", name: "x".repeat(65) },
    ]) {
      expect(() => decodeHostToRelay(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
    for (const registered of [
      { t: "registered", features: "name" },
      { t: "registered", features: [1] },
      { t: "registered", features: Array.from({ length: 17 }, () => "x") },
    ]) {
      expect(() => decodeRelayToHost(JSON.stringify(registered)), JSON.stringify(registered)).toThrow();
    }
  });

  it("reads registered's push declaration, tolerating unknown environments", () => {
    expect(decodeRelayToHost(encodeRelayFrame({ t: "registered" }))).toEqual({ t: "registered" });
    expect(
      decodeRelayToHost(JSON.stringify({ t: "registered", push: ["production", "development", "future-env"] })),
    ).toEqual({ t: "registered", push: ["production", "development"] });
    for (const push of ["production", 5, ["production", 3], Array.from({ length: 9 }, () => "production")]) {
      expect(() => decodeRelayToHost(JSON.stringify({ t: "registered", push })), JSON.stringify(push)).toThrow();
    }
  });

  it("rejects malformed push and push-result frames", () => {
    const notification = {
      title: "t",
      body: "b",
      collapseId: "c",
      hostKey: "k",
      conversationId: 1,
    };
    for (const frame of [
      { t: "push" },
      { t: "push", requestId: "r" },
      { t: "push", requestId: "r", token: "aa", environment: "sandbox", notification },
      { t: "push", requestId: "r", token: "aa", environment: "production" },
      { t: "push", requestId: "r", token: "aa", environment: "production", notification: { ...notification, title: "" } },
      { t: "push", requestId: "r", token: "aa", environment: "production", notification: { ...notification, conversationId: 0 } },
      { t: "push", requestId: "r", token: "aa", environment: "production", notification: { ...notification, collapseId: "x".repeat(65) } },
    ]) {
      expect(() => decodeHostToRelay(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
    for (const frame of [
      { t: "push-result" },
      { t: "push-result", requestId: "r", result: "accepted" },
      { t: "push-result", requestId: "r", result: "bogus", reason: "x" },
      { t: "push-result", requestId: "r", result: "unregistered", reason: "x" },
      { t: "push-result", requestId: "r", result: "unregistered", reason: "x", unregisteredAt: "soon" },
      { t: "push-result", requestId: "r", result: "retry", reason: "x", retryAfterMs: "soon" },
    ]) {
      expect(() => decodeRelayToHost(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
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
