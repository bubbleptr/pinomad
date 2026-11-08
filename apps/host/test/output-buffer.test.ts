import { describe, expect, it } from "vitest";
import { OutputBuffer } from "../src/output-buffer.ts";

function bufferWith(text: string, maxChunk: number): OutputBuffer {
  const buffer = new OutputBuffer({ maxChunk, flushMs: 1 });
  buffer.push(text);
  buffer.flush();
  return buffer;
}

describe("OutputBuffer snapshots", () => {
  it("does not cut inside an ANSI escape and keeps next at the raw position", () => {
    const buffer = bufferWith("abc\x1b[31mred", 5);
    const first = buffer.snapshot(0, 5);
    expect(first.text).toBe("abc");
    expect(first.next).toBe(3);
    const second = buffer.snapshot(first.next, 5);
    expect(second.text.startsWith("\x1b[31m")).toBe(true);
  });

  it("advances even when one escape sequence is longer than the slice", () => {
    const buffer = bufferWith("\x1b]0;" + "x".repeat(20) + "\x07tail", 5);
    const first = buffer.snapshot(0, 5);
    expect(first.next).toBeGreaterThan(0);
    expect(first.text.length).toBe(5);
  });
});
