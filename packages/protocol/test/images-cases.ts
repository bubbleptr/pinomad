// Shared imageProblem inputs: the vitest suite and the client-side Rust
// comparison-vector generator (packages/client/test/rust-vectors.ts) both
// consume this table, so the Rust replay covers the same cases.
import { MAX_IMAGE_BYTES } from "../src/images.ts";

export const png = (data = "aGVsbG8=") => ({ data, mimeType: "image/png" });

// Decoded size = base64 length * 3/4 minus padding bytes.
const exactLength = ((MAX_IMAGE_BYTES + 1) * 4) / 3; // 6990508 — divisible by 4

export interface ImageCase {
  readonly name: string;
  readonly images: readonly { data: string; mimeType: string }[];
}

export const IMAGE_CASES: ImageCase[] = [
  { name: "empty", images: [] },
  { name: "one", images: [png()] },
  { name: "four", images: [png(), png("AAAA"), png("AAAA"), png("AAAA")] },
  { name: "five", images: [png(), png(), png(), png(), { data: "!!!", mimeType: "image/heic" }] },
  { name: "unsupported-first", images: [{ data: "aGVsbG8=", mimeType: "image/heic" }] },
  { name: "unsupported-second", images: [png(), { data: "AAAA", mimeType: "image/svg+xml" }] },
  { name: "empty-data", images: [png("")] },
  { name: "length-3", images: [png("abc")] },
  { name: "bad-chars", images: [png("aGVs bG8=")] },
  { name: "pad-middle", images: [png("AAAA=AAA")] },
  { name: "second-invalid", images: [png(), png("AA=")] },
  { name: "exact-5mb", images: [png("A".repeat(exactLength - 1) + "=")] },
  { name: "over-5mb", images: [png("A".repeat(exactLength))] },
];
