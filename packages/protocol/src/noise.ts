// Noise_IK_25519_ChaChaPoly_BLAKE2s, implemented from the Noise spec (rev 34).
// Only the IK pattern is supported: the initiator knows the responder's static
// key up front, so authentication of both sides happens in two messages.
// Messages are capped at the spec's 65535-byte Noise message bound.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

const PROTOCOL_NAME = new TextEncoder().encode("Noise_IK_25519_ChaChaPoly_BLAKE2s");
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const MAX_MESSAGE = 65535;
const MAX_NONCE = 2n ** 64n - 1n;

const hash = (data: Uint8Array): Uint8Array => blake2s(data, { dkLen: KEY_LENGTH });
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** RFC 5869 expand-only HKDF as Noise defines it (ck is the salt, ikm the secret). */
function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2): [Uint8Array, Uint8Array] {
  const tempKey = hmac(blake2s, chainingKey, ikm);
  const out1 = hmac(blake2s, tempKey, new Uint8Array([1]));
  const out2 = hmac(blake2s, tempKey, concat(out1, new Uint8Array([2])));
  return [out1, out2];
}

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  return keyPairFromPrivate(x25519.utils.randomSecretKey());
}

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== KEY_LENGTH) throw new Error(`X25519 private key must be ${KEY_LENGTH} bytes`);
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

const dh = (pair: KeyPair, remotePublic: Uint8Array): Uint8Array => x25519.getSharedSecret(pair.privateKey, remotePublic);

export interface CipherState {
  encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array;
  /** Throws on authentication failure (tampering, replay, reordering). */
  decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array;
}

export interface HandshakeResult {
  readonly send: CipherState;
  readonly receive: CipherState;
  readonly handshakeHash: Uint8Array;
}

/** Cipher state with a 64-bit nonce counter; 96-bit nonce = 32 zero bits || n (little-endian). */
class NoiseCipherState implements CipherState {
  #key: Uint8Array | undefined;
  #nonce = 0n;

  setKey(key: Uint8Array): void {
    // Noise resets n to zero on every MixKey — a fresh key means a fresh counter.
    this.#key = key;
    this.#nonce = 0n;
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    const key = this.#key;
    if (key === undefined) return plaintext;
    return chacha20poly1305(key, this.#takeNonce(), ad).encrypt(plaintext);
  }

  decrypt(ciphertext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    const key = this.#key;
    if (key === undefined) return ciphertext;
    return chacha20poly1305(key, this.#takeNonce(), ad).decrypt(ciphertext);
  }

  #takeNonce(): Uint8Array {
    if (this.#nonce === MAX_NONCE) throw new Error("nonce exhausted");
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, this.#nonce, true);
    this.#nonce += 1n;
    return nonce;
  }
}

class SymmetricState {
  #ck: Uint8Array;
  #h: Uint8Array;
  readonly cipher = new NoiseCipherState();

  constructor() {
    const name = PROTOCOL_NAME;
    this.#h = name.length <= KEY_LENGTH ? concat(name, new Uint8Array(KEY_LENGTH - name.length)) : hash(name);
    this.#ck = this.#h.slice();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempKey] = hkdf(this.#ck, ikm, 2);
    this.#ck = ck;
    this.cipher.setKey(tempKey.subarray(0, KEY_LENGTH));
  }

  mixHash(data: Uint8Array): void {
    this.#h = hash(concat(this.#h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encrypt(plaintext, this.#h);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decrypt(ciphertext, this.#h);
    this.mixHash(ciphertext);
    return plaintext;
  }

  get handshakeHash(): Uint8Array {
    return this.#h;
  }

  split(): [CipherState, CipherState] {
    const [key1, key2] = hkdf(this.#ck, new Uint8Array(0), 2);
    const first = new NoiseCipherState();
    first.setKey(key1.subarray(0, KEY_LENGTH));
    const second = new NoiseCipherState();
    second.setKey(key2.subarray(0, KEY_LENGTH));
    return [first, second];
  }
}

/**
 * Read `size` bytes off the front of `message`, or throw when the message is
 * short — a short message is a protocol violation, not a decryption failure.
 */
function take(message: { buffer: Uint8Array; offset: number }, size: number): Uint8Array {
  if (message.offset + size > message.buffer.length) throw new Error("malformed Noise message");
  const slice = message.buffer.subarray(message.offset, message.offset + size);
  message.offset += size;
  return slice;
}

/**
 * `-> e, es, s, ss` for the initiator; the same tokens parsed by the responder
 * (which additionally learns the initiator's static key).
 */
function writeMessage1(
  state: SymmetricState,
  buffer: Uint8Array[],
  own: { static: KeyPair; ephemeral: KeyPair },
  remoteStatic: Uint8Array,
): void {
  buffer.push(own.ephemeral.publicKey);
  state.mixHash(own.ephemeral.publicKey);
  state.mixKey(dh(own.ephemeral, remoteStatic)); // es
  buffer.push(state.encryptAndHash(own.static.publicKey)); // s
  state.mixKey(dh(own.static, remoteStatic)); // ss
}

function readMessage1(
  state: SymmetricState,
  message: { buffer: Uint8Array; offset: number },
  own: { static: KeyPair },
): { remoteEphemeral: Uint8Array; remoteStatic: Uint8Array } {
  const remoteEphemeral = take(message, KEY_LENGTH).slice();
  state.mixHash(remoteEphemeral);
  state.mixKey(dh(own.static, remoteEphemeral)); // es
  const remoteStatic = state.decryptAndHash(take(message, KEY_LENGTH + TAG_LENGTH)).slice(); // s
  if (remoteStatic.length !== KEY_LENGTH) throw new Error("bad remote static key");
  state.mixKey(dh(own.static, remoteStatic)); // ss
  return { remoteEphemeral, remoteStatic };
}

/** `<- e, ee, se` for the responder; parsed by the initiator. */
function writeMessage2(
  state: SymmetricState,
  buffer: Uint8Array[],
  own: { ephemeral: KeyPair },
  remoteEphemeral: Uint8Array,
  remoteStatic: Uint8Array,
): void {
  buffer.push(own.ephemeral.publicKey);
  state.mixHash(own.ephemeral.publicKey);
  state.mixKey(dh(own.ephemeral, remoteEphemeral)); // ee
  state.mixKey(dh(own.ephemeral, remoteStatic)); // se
}

function readMessage2Tokens(
  state: SymmetricState,
  message: { buffer: Uint8Array; offset: number },
  own: { ephemeral: KeyPair; static: KeyPair },
): Uint8Array {
  const remoteEphemeral = take(message, KEY_LENGTH).slice();
  state.mixHash(remoteEphemeral);
  state.mixKey(dh(own.ephemeral, remoteEphemeral)); // ee
  state.mixKey(dh(own.static, remoteEphemeral)); // se
  return remoteEphemeral;
}

const checkLength = (message: Uint8Array, what: string): void => {
  if (message.length > MAX_MESSAGE) throw new Error(`${what} exceeds ${MAX_MESSAGE} bytes`);
};

// IK pre-messages: `<- s` — the responder's static is a known value on both
// sides, hashed before anything else.
function initialize(prologue: Uint8Array, responderStatic: Uint8Array): SymmetricState {
  const state = new SymmetricState();
  state.mixHash(prologue);
  state.mixHash(responderStatic);
  return state;
}

/**
 * Initiator side of IK. `ephemeral` exists for test vectors; production callers
 * leave it out and get a fresh ephemeral every handshake.
 */
export function initiateIK(options: {
  prologue: Uint8Array;
  static: KeyPair;
  remoteStatic: Uint8Array;
  ephemeral?: KeyPair;
}): {
  writeMessage1(payload: Uint8Array): Uint8Array;
  readMessage2(message: Uint8Array): { payload: Uint8Array; result: HandshakeResult };
} {
  const ephemeral = options.ephemeral ?? generateKeyPair();
  const state = initialize(options.prologue, options.remoteStatic);
  return {
    writeMessage1(payload) {
      const buffer: Uint8Array[] = [];
      writeMessage1(state, buffer, { static: options.static, ephemeral }, options.remoteStatic);
      buffer.push(state.encryptAndHash(payload));
      const message = concat(...buffer);
      checkLength(message, "handshake message");
      return message;
    },
    readMessage2(message) {
      checkLength(message, "handshake message");
      const reader = { buffer: message, offset: 0 };
      readMessage2Tokens(state, reader, { ephemeral, static: options.static });
      const payload = state.decryptAndHash(take(reader, message.length - reader.offset));
      const [send, receive] = state.split();
      return { payload, result: { send, receive, handshakeHash: state.handshakeHash } };
    },
  };
}

/** Responder side of IK. */
export function respondIK(options: {
  prologue: Uint8Array;
  static: KeyPair;
  ephemeral?: KeyPair;
}): {
  readMessage1(message: Uint8Array): { payload: Uint8Array; remoteStatic: Uint8Array };
  writeMessage2(payload: Uint8Array): { message: Uint8Array; result: HandshakeResult };
} {
  const ephemeral = options.ephemeral ?? generateKeyPair();
  const state = initialize(options.prologue, options.static.publicKey);
  let remoteEphemeral: Uint8Array | undefined;
  let remoteStatic: Uint8Array | undefined;
  return {
    readMessage1(message) {
      checkLength(message, "handshake message");
      const reader = { buffer: message, offset: 0 };
      const remote = readMessage1(state, reader, { static: options.static });
      remoteEphemeral = remote.remoteEphemeral;
      remoteStatic = remote.remoteStatic;
      const payload = state.decryptAndHash(take(reader, message.length - reader.offset));
      return { payload, remoteStatic };
    },
    writeMessage2(payload) {
      if (remoteEphemeral === undefined || remoteStatic === undefined) throw new Error("message 2 before message 1");
      const buffer: Uint8Array[] = [];
      writeMessage2(state, buffer, { ephemeral }, remoteEphemeral, remoteStatic);
      buffer.push(state.encryptAndHash(payload));
      const message = concat(...buffer);
      checkLength(message, "handshake message");
      const [receive, send] = state.split();
      // Responder: split's second CipherState sends, the first receives.
      return { message, result: { send, receive, handshakeHash: state.handshakeHash } };
    },
  };
}
