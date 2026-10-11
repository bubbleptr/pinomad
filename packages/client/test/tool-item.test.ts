import { describe, expect, it } from "vitest";
import { formatToolDuration, toolTargetFromArgs } from "../src/tool-item.ts";

describe("toolTargetFromArgs", () => {
  it("extracts the most specific common key from JSON args", () => {
    expect(toolTargetFromArgs('{"path":"src/index.ts"}')).toBe("src/index.ts");
    expect(toolTargetFromArgs('{"file_path":"a.ts","limit":5}')).toBe("a.ts");
    expect(toolTargetFromArgs('{"command":"git diff --stat"}')).toBe("git diff --stat");
    expect(toolTargetFromArgs('{"query":"astryx tokens"}')).toBe("astryx tokens");
  });

  it("returns undefined for malformed, empty, or keyless args", () => {
    expect(toolTargetFromArgs(undefined)).toBeUndefined();
    expect(toolTargetFromArgs("not json")).toBeUndefined();
    expect(toolTargetFromArgs('{"foo":1}')).toBeUndefined();
    expect(toolTargetFromArgs('{"path":42}')).toBeUndefined();
  });

  it("truncates very long targets", () => {
    const target = toolTargetFromArgs(JSON.stringify({ command: "x".repeat(300) }));
    expect(target).toHaveLength(121);
    expect(target?.endsWith("…")).toBe(true);
  });
});

describe("formatToolDuration", () => {
  it("formats sub-second as ms and seconds with one decimal", () => {
    expect(formatToolDuration(45)).toBe("45ms");
    expect(formatToolDuration(999)).toBe("999ms");
    expect(formatToolDuration(3200)).toBe("3.2s");
    expect(formatToolDuration(60_000)).toBe("60.0s");
  });

  it("returns undefined for missing or invalid input", () => {
    expect(formatToolDuration(undefined)).toBeUndefined();
    expect(formatToolDuration(-5)).toBeUndefined();
    expect(formatToolDuration(Number.NaN)).toBeUndefined();
  });
});
