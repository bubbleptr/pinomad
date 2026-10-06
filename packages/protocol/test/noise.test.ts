import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateKeyPair, initiateIK, keyPairFromPrivate, respondIK, type HandshakeResult } from "../src/noise.ts";
import {
  decodeClientHello,
  decodeHostHello,
  encodeClientHello,
  encodeHostHello,
  fromBase64Url,
  SECURE_PROLOGUE,
  SecureSession,
  toBase64Url,
} from "../src/secure-channel.ts";

const hex = (text: string): Uint8Array => new Uint8Array(text.match(/../g)!.map((byte) => parseInt(byte, 16)));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

interface Vector {
  readonly init_prologue: string;
  readonly init_static: string;
  readonly init_ephemeral: string;
  readonly init_remote_static: string;
  readonly resp_prologue: string;
  readonly resp_static: string;
  readonly resp_ephemeral: string;
  readonly handshake_hash: string;
  readonly messages: readonly { readonly payload: string; readonly ciphertext: string }[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/noise-ik-vectors.json", import.meta.url), "utf8"),
) as { readonly vectors: readonly Vector[] };

/** A completed two-party handshake with generated keys. */
function handshakePair(): { client: HandshakeResult; server: HandshakeResult } {
  const host = generateKeyPair();
  const device = generateKeyPair();
  const initiator = initiateIK({ prologue: SECURE_PROLOGUE, static: device, remoteStatic: host.publicKey });
  const responder = respondIK({ prologue: SECURE_PROLOGUE, static: host });
  const first = initiator.writeMessage1(new Uint8Array(0));
  responder.readMessage1(first);
  const second = responder.writeMessage2(new Uint8Array(0));
  const { result: client } = initiator.readMessage2(second.message);
  return { client, server: second.result };
}

describe("Noise IK vectors", () => {
  it.each(fixture.vectors.map((vector, index) => [index, vector] as const))(
    "vector %i matches every handshake and transport message",
    (_index, vector) => {
      const initiator = initiateIK({
        prologue: hex(vector.init_prologue),
        static: keyPairFromPrivate(hex(vector.init_static)),
        remoteStatic: hex(vector.init_remote_static),
        ephemeral: keyPairFromPrivate(hex(vector.init_ephemeral)),
      });
      const responder = respondIK({
        prologue: hex(vector.resp_prologue),
        static: keyPairFromPrivate(hex(vector.resp_static)),
        ephemeral: keyPairFromPrivate(hex(vector.resp_ephemeral)),
      });
      const [first, second, ...transport] = vector.messages.map((message) => ({
        payload: hex(message.payload),
        ciphertext: hex(message.ciphertext),
      }));

      expect(toHex(initiator.writeMessage1(first.payload))).toBe(toHex(first.ciphertext));
      const opened = responder.readMessage1(first.ciphertext);
      expect(toHex(opened.payload)).toBe(toHex(first.payload));
      expect(toHex(opened.remoteStatic)).toBe(toHex(keyPairFromPrivate(hex(vector.init_static)).publicKey));

      const reply = responder.writeMessage2(second.payload);
      expect(toHex(reply.message)).toBe(toHex(second.ciphertext));
      const finished = initiator.readMessage2(second.ciphertext);
      expect(toHex(finished.payload)).toBe(toHex(second.payload));
      expect(toHex(finished.result.handshakeHash)).toBe(vector.handshake_hash);
      expect(toHex(reply.result.handshakeHash)).toBe(vector.handshake_hash);

      // Transport messages alternate initiator→responder, responder→initiator.
      for (const [index, message] of transport.entries()) {
        const sender = index % 2 === 0 ? finished.result : reply.result;
        const receiver = index % 2 === 0 ? reply.result : finished.result;
        const encrypted = sender.send.encrypt(message.payload);
        expect(toHex(encrypted)).toBe(toHex(message.ciphertext));
        expect(toHex(receiver.receive.decrypt(message.ciphertext))).toBe(toHex(message.payload));
      }
    },
  );
});

describe("SecureSession", () => {
  const roundTrip = (text: string): { chunks: Uint8Array[]; opened: (string | undefined)[] } => {
    const { client, server } = handshakePair();
    const sender = new SecureSession(client);
    const receiver = new SecureSession(server);
    const chunks = sender.seal(text);
    return { chunks, opened: chunks.map((chunk) => receiver.open(chunk)) };
  };

  it("round-trips a short frame in a single chunk", () => {
    const { chunks, opened } = roundTrip('{"type":"subscribe","stream":"tasks"}');
    expect(chunks).toHaveLength(1);
    expect(opened).toEqual(['{"type":"subscribe","stream":"tasks"}']);
  });

  it("round-trips unicode", () => {
    const text = "中文消息 ✓ emoji 🚀 done";
    const { opened } = roundTrip(text);
    expect(opened.at(-1)).toBe(text);
  });

  it("splits a large frame into chunks of at most 65535 encrypted bytes", () => {
    const text = "x".repeat(200 * 1024) + "tail 中文";
    const { chunks, opened } = roundTrip(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(65535);
    expect(opened.slice(0, -1)).toEqual(chunks.slice(0, -1).map(() => undefined));
    expect(opened.at(-1)).toBe(text);
  });

  it("round-trips an empty frame", () => {
    const { chunks, opened } = roundTrip("");
    expect(chunks).toHaveLength(1);
    expect(opened).toEqual([""]);
  });

  it("rejects a tampered chunk", () => {
    const { client, server } = handshakePair();
    const sender = new SecureSession(client);
    const receiver = new SecureSession(server);
    const [chunk] = sender.seal("hello");
    const tampered = chunk.slice();
    tampered[3]! ^= 1;
    expect(() => receiver.open(tampered)).toThrow();
  });

  it("rejects a replayed chunk", () => {
    const { client, server } = handshakePair();
    const sender = new SecureSession(client);
    const receiver = new SecureSession(server);
    const [chunk] = sender.seal("hello");
    expect(receiver.open(chunk)).toBe("hello");
    expect(() => receiver.open(chunk)).toThrow();
  });

  it("rejects reordered chunks", () => {
    const { client, server } = handshakePair();
    const sender = new SecureSession(client);
    const receiver = new SecureSession(server);
    const [first] = sender.seal("one");
    const [second] = sender.seal("two");
    // The second message's nonce does not match the next expected receive nonce.
    expect(() => receiver.open(second)).toThrow();
    // And after that failure the first message no longer arrives either.
    expect(() => receiver.open(first)).toThrow();
  });

  it("rejects a chunk from the wrong direction", () => {
    const { client } = handshakePair();
    const a = new SecureSession(client);
    const b = new SecureSession(client);
    const [chunk] = a.seal("same keys, wrong role");
    expect(() => b.open(chunk)).toThrow();
  });
});

describe("handshake misuse", () => {
  it("rejects message 1 sealed to the wrong responder key", () => {
    const device = generateKeyPair();
    const host = generateKeyPair();
    const other = generateKeyPair();
    const initiator = initiateIK({ prologue: SECURE_PROLOGUE, static: device, remoteStatic: other.publicKey });
    const responder = respondIK({ prologue: SECURE_PROLOGUE, static: host });
    const first = initiator.writeMessage1(new Uint8Array(0));
    expect(() => responder.readMessage1(first)).toThrow();
  });

  it("rejects a truncated message 2", () => {
    const host = generateKeyPair();
    const device = generateKeyPair();
    const initiator = initiateIK({ prologue: SECURE_PROLOGUE, static: device, remoteStatic: host.publicKey });
    const responder = respondIK({ prologue: SECURE_PROLOGUE, static: host });
    responder.readMessage1(initiator.writeMessage1(new Uint8Array(0)));
    const { message } = responder.writeMessage2(new Uint8Array(0));
    expect(() => initiator.readMessage2(message.slice(0, 10))).toThrow();
  });
});

describe("handshake payloads", () => {
  it("round-trips a client hello with and without pairing", () => {
    expect(decodeClientHello(encodeClientHello({ v: 1 }))).toEqual({ v: 1 });
    expect(decodeClientHello(encodeClientHello({ v: 1, pair: { secret: "s", name: "phone" } }))).toEqual({
      v: 1,
      pair: { secret: "s", name: "phone" },
    });
    expect(decodeHostHello(encodeHostHello({ v: 1 }))).toEqual({ v: 1 });
  });

  it("rejects bad JSON and wrong version", () => {
    expect(() => decodeClientHello(new Uint8Array([1, 2, 3]))).toThrow();
    const wrong = new TextEncoder().encode(JSON.stringify({ v: 2 }));
    expect(() => decodeClientHello(wrong)).toThrow();
    expect(() => decodeHostHello(wrong)).toThrow();
    const missing = new TextEncoder().encode(JSON.stringify({}));
    expect(() => decodeClientHello(missing)).toThrow();
    const badPair = new TextEncoder().encode(JSON.stringify({ v: 1, pair: { secret: 1 } }));
    expect(() => decodeClientHello(badPair)).toThrow();
  });

  it("round-trips base64url including partial quads", () => {
    for (const size of [1, 2, 3, 32, 33, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(size));
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    expect(toBase64Url(new Uint8Array([255, 255, 255]))).toBe("____");
    expect(() => fromBase64Url("abc=")).toThrow();
    // A one-character quad encodes 6 bits that can't form a byte.
    expect(() => fromBase64Url("abcde")).toThrow();
    expect(() => fromBase64Url("e")).toThrow();
  });
});
