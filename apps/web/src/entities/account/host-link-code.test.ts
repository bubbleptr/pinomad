import { describe, expect, it } from "vitest";
import { formatUserCode, isCompleteUserCode, normalizeUserCode } from "./host-link-code.ts";

describe("host link user codes", () => {
  it("takes the code however it was typed: lowercase, spaces and the dash", () => {
    expect(normalizeUserCode("kxhn-bwcv")).toBe("KXHNBWCV");
    expect(normalizeUserCode("  KXHN BWCV ")).toBe("KXHNBWCV");
    expect(normalizeUserCode("kx hn–bw-cv")).toBe("KXHNBWCV");
  });

  it("stops at eight letters, so a pasted line can't carry more", () => {
    expect(normalizeUserCode("KXHN-BWCV and more")).toBe("KXHNBWCV");
  });

  it("shows the code as XXXX-XXXX once it's past the first group", () => {
    expect(formatUserCode("KXH")).toBe("KXH");
    expect(formatUserCode("KXHN")).toBe("KXHN");
    expect(formatUserCode("KXHNB")).toBe("KXHN-B");
    expect(formatUserCode(normalizeUserCode("kxhnbwcv"))).toBe("KXHN-BWCV");
  });

  it("is complete only with all eight letters", () => {
    expect(isCompleteUserCode("KXHNBWC")).toBe(false);
    expect(isCompleteUserCode("KXHNBWCV")).toBe(true);
  });
});
