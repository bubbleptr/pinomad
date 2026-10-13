import { describe, expect, it } from "vitest";
import { imageProblem, MAX_IMAGE_BYTES } from "../src/images.ts";

const png = (data = "aGVsbG8=") => ({ data, mimeType: "image/png" });

describe("imageProblem", () => {
  it("accepts no images and up to four small ones", () => {
    expect(imageProblem([])).toBeUndefined();
    expect(imageProblem([png()])).toBeUndefined();
    expect(imageProblem([png(), png("AAAA"), png("AAAA"), png("AAAA")])).toBeUndefined();
  });

  it("rejects a fifth image before checking anything else", () => {
    expect(imageProblem([png(), png(), png(), png(), { data: "!!!", mimeType: "image/heic" }])).toBe(
      "At most 4 images per message",
    );
  });

  it("rejects an unsupported mime type", () => {
    expect(imageProblem([{ data: "aGVsbG8=", mimeType: "image/heic" }])).toBe(
      "Unsupported image type: image/heic (use JPEG, PNG, GIF or WebP)",
    );
    expect(imageProblem([png(), { data: "AAAA", mimeType: "image/svg+xml" }])).toBe(
      "Unsupported image type: image/svg+xml (use JPEG, PNG, GIF or WebP)",
    );
  });

  it("rejects malformed base64, naming the 1-based image", () => {
    expect(imageProblem([png("")])).toBe("Image 1 is not valid base64");
    // Not a multiple of 4.
    expect(imageProblem([png("abc")])).toBe("Image 1 is not valid base64");
    // Characters outside the base64 alphabet.
    expect(imageProblem([png("aGVs bG8=")])).toBe("Image 1 is not valid base64");
    expect(imageProblem([png(), png("AA=")])).toBe("Image 2 is not valid base64");
  });

  it("accepts exactly 5 MB decoded and rejects one byte over", () => {
    // Decoded size = base64 length * 3/4 minus padding bytes.
    const exactLength = ((MAX_IMAGE_BYTES + 1) * 4) / 3; // 6990508 — divisible by 4
    expect(exactLength % 4).toBe(0);
    const exact = "A".repeat(exactLength - 1) + "="; // 5 MB decoded exactly
    expect(imageProblem([png(exact)])).toBeUndefined();
    const over = "A".repeat(exactLength); // no padding: 5 MB + 1
    expect(imageProblem([png(over)])).toBe("Image 1 is larger than 5 MB");
  });
});
