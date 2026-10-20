import { describe, expect, it } from "vitest";
import { cleanHostName, normalizeHostName, HOST_NAME_FALLBACK, HOST_NAME_MAX_UNITS } from "../src/settings.ts";
import { parseClientFrame } from "../src/frames.ts";

const call = (patch: Record<string, unknown>) =>
  parseClientFrame({ type: "call", id: 1, method: "updateSettings", args: { patch } });

describe("normalizeHostName", () => {
  it("strips a trailing .local — the mDNS suffix a hostname may carry", () => {
    expect(normalizeHostName("omarchy.local")).toBe("omarchy");
    expect(normalizeHostName("Desk.local")).toBe("Desk");
    // Only the suffix goes: ".local" elsewhere is a real part of the name.
    expect(normalizeHostName("local.host")).toBe("local.host");
    expect(normalizeHostName("my.local.host")).toBe("my.local.host");
  });

  it("trims and removes control characters", () => {
    expect(normalizeHostName("  Desk  ")).toBe("Desk");
    expect(normalizeHostName("De\u0007sk")).toBe("Desk");
    expect(normalizeHostName("De\tsk")).toBe("Desk");
    expect(normalizeHostName("Desk\n")).toBe("Desk");
    // DEL and C1 controls go too; ordinary non-ASCII names survive.
    expect(normalizeHostName("De\u007fsk")).toBe("Desk");
    expect(normalizeHostName("De\u0085sk")).toBe("Desk");
    expect(normalizeHostName("\u5de5\u4f5c\u53f0")).toBe("\u5de5\u4f5c\u53f0");
    expect(normalizeHostName("Desk \ud83d\ude80")).toBe("Desk \ud83d\ude80");
  });

  it("caps the name at 64 UTF-16 units", () => {
    expect(normalizeHostName("a".repeat(HOST_NAME_MAX_UNITS + 10))).toBe("a".repeat(HOST_NAME_MAX_UNITS));
    expect(normalizeHostName("\u5de5".repeat(HOST_NAME_MAX_UNITS))).toHaveLength(HOST_NAME_MAX_UNITS);
  });

  it("falls back when nothing usable remains", () => {
    expect(normalizeHostName("")).toBe(HOST_NAME_FALLBACK);
    expect(normalizeHostName("   ")).toBe(HOST_NAME_FALLBACK);
    expect(normalizeHostName("\u0000\u0001")).toBe(HOST_NAME_FALLBACK);
    expect(normalizeHostName(".local")).toBe(HOST_NAME_FALLBACK);
  });
});

describe("cleanHostName", () => {
  it("is normalizeHostName without the fallback: empty stays empty", () => {
    expect(cleanHostName("")).toBe("");
    expect(cleanHostName("  ")).toBe("");
    expect(cleanHostName("\0")).toBe("");
    expect(cleanHostName(".local")).toBe("");
    expect(cleanHostName("Desk.local")).toBe("Desk");
  });

  it("reaches a fixed point — one pass can leave another suffix or space", () => {
    // ".local " keeps its suffix past the single-pass strip order; a stored
    // name must be canonical so the announced value is what was written.
    expect(cleanHostName(".local ")).toBe("");
    expect(cleanHostName("Desk.local ")).toBe("Desk");
    expect(cleanHostName("a.local.local")).toBe("a");
    expect(cleanHostName(cleanHostName(".local "))).toBe("");
    expect(cleanHostName(cleanHostName("a.local.local"))).toBe("a");
  });
});

describe("updateSettings hostName frame validation", () => {
  const frame = (patch: Record<string, unknown>) => call(patch);

  it("accepts a string or null hostName — content rules are the host's (5.12)", () => {
    expect(frame({ hostName: "Desk" })).toEqual({
      kind: "frame",
      frame: { type: "call", id: 1, method: "updateSettings", args: { patch: { hostName: "Desk" } } },
    });
    expect(frame({ hostName: null })).toEqual({
      kind: "frame",
      frame: { type: "call", id: 1, method: "updateSettings", args: { patch: { hostName: null } } },
    });
    // Even content the host will refuse parses — a bad name is ok:false, not 4400.
    expect(frame({ hostName: "" }).kind).toBe("frame");
  });

  it("rejects non-string hostName values as malformed", () => {
    for (const hostName of [42, true, ["x"], { name: "x" }]) {
      expect(frame({ hostName }).kind).toBe("malformed");
    }
  });
});
