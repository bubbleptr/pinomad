// The secure channel: a Noise IK handshake (noise.ts) plus a record layer that
// carries serialized frames as encrypted chunks, and a FrameTransport that runs
// it over a WebSocket. Browser-safe: no node: imports, no Buffer.

import { initiateIK, type CipherState, type HandshakeResult, type KeyPair } from "./noise.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "./transport.ts";

export const SECURE_PROLOGUE = new TextEncoder().encode("pinomad/1");

/** Client → host handshake payload (UTF-8 JSON inside handshake message 1). */
export type ClientHello = { readonly v: 1; readonly pair?: { readonly secret: string; readonly name: string } };
/** Host → client handshake payload (inside handshake message 2). */
export type HostHello = { readonly v: 1 };

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder("utf-8", { fatal: true });

export const encodeClientHello = (hello: ClientHello): Uint8Array => utf8.encode(JSON.stringify(hello));
export const encodeHostHello = (hello: HostHello): Uint8Array => utf8.encode(JSON.stringify(hello));

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decode.decode(bytes));
  } catch {
    throw new Error("handshake payload is not JSON");
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

export function decodeClientHello(bytes: Uint8Array): ClientHello {
  const value = decodeJson(bytes) as { v?: unknown; pair?: unknown };
  if (value?.v !== 1) throw new Error("unsupported client hello");
  const pair = value.pair as { secret?: unknown; name?: unknown } | undefined;
  if (pair === undefined) return { v: 1 };
  const secret = pair.secret;
  const name = pair.name;
  if (!isString(secret) || !isString(name)) throw new Error("malformed pair");
  return { v: 1, pair: { secret, name } };
}

export function decodeHostHello(bytes: Uint8Array): HostHello {
  const value = decodeJson(bytes) as { v?: unknown };
  if (value?.v !== 1) throw new Error("unsupported host hello");
  return { v: 1 };
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without Buffer/atob — works in every runtime including Hermes. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += B64_ALPHABET[a >> 2]! + B64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64_ALPHABET[c & 63]!;
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  // A trailing quad of one character encodes 6 bits that can't make a byte.
  if (text.length % 4 === 1) throw new Error("invalid base64url");
  const lookup = new Map<string, number>(Array.from(B64_ALPHABET, (char, index) => [char, index]));
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 4) {
    const quad = text.slice(index, index + 4);
    const values = [...quad].map((char) => {
      const value = lookup.get(char);
      if (value === undefined) throw new Error("invalid base64url");
      return value;
    });
    const packed = values.reduce((bits, value, index) => bits | (value << (18 - index * 6)), 0);
    bytes.push((packed >> 16) & 255);
    if (values.length > 2) bytes.push((packed >> 8) & 255);
    if (values.length > 3) bytes.push(packed & 255);
  }
  return new Uint8Array(bytes);
}

// Record layer: plaintext = flag byte (1 = more follows, 0 = final) + body, so
// each encrypted chunk stays within Noise's 65535-byte message bound.
const MAX_BODY = 65535 - 16 - 1;

export class SecureSession {
  readonly #send: CipherState;
  readonly #receive: CipherState;
  #pending: Uint8Array[] = [];

  constructor(result: HandshakeResult) {
    this.#send = result.send;
    this.#receive = result.receive;
  }

  /** One text frame → one or more encrypted records, each ≤ 65535 bytes. */
  seal(text: string): Uint8Array[] {
    const body = utf8.encode(text);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset <= body.length; offset += MAX_BODY) {
      const last = offset + MAX_BODY >= body.length;
      const record = new Uint8Array(1 + Math.min(MAX_BODY, body.length - offset));
      record[0] = last ? 0 : 1;
      record.set(body.subarray(offset, offset + MAX_BODY), 1);
      chunks.push(this.#send.encrypt(record));
      if (last) break;
    }
    return chunks;
  }

  /**
   * The inverse of `seal`: returns the complete text on the final chunk,
   * `undefined` while more chunks are expected. Throws on any authentication
   * failure — after one, the session is unusable and the caller should close.
   */
  open(chunk: Uint8Array): string | undefined {
    const record = this.#receive.decrypt(chunk);
    const flag = record[0];
    if (flag !== 0 && flag !== 1) throw new Error("bad record flag");
    this.#pending.push(record.subarray(1));
    if (flag === 1) return undefined;
    const whole = concatParts(this.#pending);
    this.#pending = [];
    return utf8Decode.decode(whole);
  }
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A FrameTransport over a WebSocket carrying Noise-encrypted frames. The device
 * knows the host's static key (from the pairing QR or a previous pairing).
 * While `pairing` is set, the first connection's handshake payload carries the
 * one-time secret; once that connection's handshake completes, `onPaired` fires
 * and later connections — including reconnects of this transport — go plain IK.
 */
export function secureWebSocketTransport(options: {
  url: string;
  hostKey: Uint8Array;
  device: KeyPair;
  pairing?: { secret: string; name: string };
  onPaired?: () => void;
}): FrameTransport {
  let pairing = options.pairing;
  return {
    label: options.url,
    open(handlers): FrameConnection {
      const socket = new WebSocket(options.url);
      socket.binaryType = "arraybuffer";
      const handshake = initiateIK({
        prologue: SECURE_PROLOGUE,
        static: options.device,
        remoteStatic: options.hostKey,
      });
      let session: SecureSession | undefined;
      let queue: string[] = [];
      let closedFired = false;
      const fireClosed = (code: number, reason?: string): void => {
        if (closedFired) return;
        closedFired = true;
        handlers.closed(code, reason);
      };
      const fail = (reason: string): void => {
        // close() only accepts 1000 or 3000–4999 — 1008 would throw and leak the
        // socket. The peer sees a normal close; the caller still gets 1008.
        socket.close();
        fireClosed(1008, reason);
      };

      socket.onopen = () => {
        const hello: ClientHello = pairing === undefined ? { v: 1 } : { v: 1, pair: pairing };
        socket.send(handshake.writeMessage1(encodeClientHello(hello)));
      };
      socket.onmessage = (event) => {
        try {
          const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data as ArrayBufferLike);
          if (session === undefined) {
            const { payload, result } = handshake.readMessage2(bytes);
            decodeHostHello(payload);
            session = new SecureSession(result);
            if (pairing !== undefined) {
              pairing = undefined;
              options.onPaired?.();
            }
            const pending = queue;
            queue = [];
            for (const text of pending) for (const chunk of session.seal(text)) socket.send(chunk);
          } else {
            const text = session.open(bytes);
            if (text !== undefined) handlers.message(text);
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : "secure channel failure");
        }
      };
      socket.onclose = (event) => fireClosed(event.code, event.reason === "" ? undefined : event.reason);
      socket.onerror = () => {};
      return {
        send(text) {
          if (session === undefined) {
            queue.push(text);
            return;
          }
          for (const chunk of session.seal(text)) socket.send(chunk);
        },
        close() {
          socket.close();
        },
      };
    },
  };
}
