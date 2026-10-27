import { describe, expect, it } from "vitest";
import type { RtcAddressScope, RtcSelectedPair } from "@pinomad/protocol/rtc.ts";
import { agoLabel, routeScope } from "./hosts-diagnostics.ts";

function pair(local: RtcAddressScope, remote: RtcAddressScope): RtcSelectedPair {
  return { local: { scope: local }, remote: { scope: remote } };
}

describe("routeScope", () => {
  it("prefers the host's scope over this device's", () => {
    expect(routeScope(pair("lan", "tailnet"))).toBe("tailnet");
  });

  it("falls back to this device when the host's scope is unknown", () => {
    expect(routeScope(pair("lan", "unknown"))).toBe("lan");
  });

  it("has no route when both ends are unknown or no pair is selected", () => {
    expect(routeScope(pair("unknown", "unknown"))).toBeUndefined();
    expect(routeScope(undefined)).toBeUndefined();
  });
});

describe("agoLabel", () => {
  it("counts whole seconds below a minute", () => {
    expect(agoLabel(0)).toBe("0s ago");
    expect(agoLabel(59_999)).toBe("59s ago");
  });

  it("switches to minutes at one minute and to hours at one hour", () => {
    expect(agoLabel(60_000)).toBe("1m ago");
    expect(agoLabel(3_599_999)).toBe("59m ago");
    expect(agoLabel(3_600_000)).toBe("1h ago");
  });

  it("does not go negative", () => {
    expect(agoLabel(-5_000)).toBe("0s ago");
  });
});
