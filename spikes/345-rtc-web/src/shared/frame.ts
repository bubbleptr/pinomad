// Deterministic multi-MiB JSON frames for the Noise record/backpressure test.
// Both peers build the same text from the same seed and byte count, so a
// successful open can be compared byte for byte without shipping a payload.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const PATTERN = "0123456789abcdef";

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Valid JSON text whose UTF-8 length is exactly `bytes` (all ASCII). */
export function makeFrame(seed: number, bytes: number): string {
  const head = `{"kind":"spike-345-frame","seed":${seed},"bytes":${bytes},"blob":"`;
  const tail = '"}';
  const blobBytes = bytes - head.length - tail.length;
  if (blobBytes < 0) throw new Error(`frame is too small for its header: ${bytes}`);
  const blob = PATTERN.repeat(Math.ceil(blobBytes / PATTERN.length)).slice(0, blobBytes);
  const text = head + blob + tail;
  if (utf8Length(text) !== bytes) throw new Error(`frame length mismatch: wanted ${bytes}, built ${utf8Length(text)}`);
  return text;
}

// Pure JS on purpose: the LAN run serves the page over http://<tailnet-ip>, an
// insecure context where crypto.subtle is unavailable. @noble/hashes is already
// in the environment bundle for Noise.
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/** Stable non-zero pattern for raw max-message-size probes. */
export function bytePattern(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = index & 0xff;
  return out;
}

export function matchesBytePattern(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== (index & 0xff)) return false;
  }
  return true;
}

export function recordStats(records: readonly Uint8Array[], plaintextBytes: number): {
  count: number;
  min: number;
  max: number;
  ciphertextBytes: number;
  expectedCount: number;
  allWithinLimit: boolean;
} {
  const lengths = records.map((record) => record.byteLength);
  return {
    count: records.length,
    min: lengths.length === 0 ? 0 : Math.min(...lengths),
    max: lengths.length === 0 ? 0 : Math.max(...lengths),
    ciphertextBytes: lengths.reduce((sum, length) => sum + length, 0),
    // 65535-byte record = 1 byte flag + 65518 bytes body + 16 bytes tag.
    expectedCount: Math.ceil(plaintextBytes / (65535 - 16 - 1)),
    allWithinLimit: lengths.every((length) => length <= 65535),
  };
}
