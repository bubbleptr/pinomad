// What the host reads from `npm view pinomad@latest version time pinomad --json` (ADR-0043 §5),
// and when it may upgrade itself (§4).
import { describe, expect, it } from "vitest";
import { outputTail, parseRelease } from "../src/upgrade/npm.ts";
import { upgradeBlocker } from "../src/upgrade/host-upgrader.ts";
import type { ServiceManager, ServiceState } from "../src/service/manager.ts";

const VIEW = {
  version: "0.14.0",
  time: { created: "2026-10-09T08:10:24.390Z", "0.13.0": "2026-11-05T15:26:41.270Z", "0.14.0": "2026-11-09T10:00:00.000Z" },
};

describe("parseRelease", () => {
  it("reads the version, its publish time and the protocol major", () => {
    expect(parseRelease(JSON.stringify({ ...VIEW, pinomad: { protocolMajor: 5 } }))).toEqual({
      version: "0.14.0",
      publishedAt: Date.parse("2026-11-09T10:00:00.000Z"),
      protocolMajor: 5,
    });
  });

  it("leaves the major out for a release published before the field existed", () => {
    expect(parseRelease(JSON.stringify(VIEW))).not.toHaveProperty("protocolMajor");
  });

  it("rejects output without a publish time for the version", () => {
    expect(() => parseRelease(JSON.stringify({ version: "0.14.0", time: {} }))).toThrow(/publish time/);
  });
});

describe("outputTail", () => {
  it("keeps the last non-empty lines", () => {
    expect(outputTail("a\n\nb\nc\n", 2)).toBe("b\nc");
  });
});

describe("upgradeBlocker", () => {
  const spec = { dataDir: "/data" } as Awaited<ReturnType<ServiceManager["read"]>>;
  const manager = (state: Partial<ServiceState>, read = spec) => () => ({
    read: async () => read,
    state: async () => ({ installed: true, stopped: false, running: true, detail: "", ...state }),
  });

  it("lets the running service for this data dir upgrade itself", async () => {
    expect(await upgradeBlocker("/data", { packaged: true, manager: manager({}) })).toBeNull();
  });

  it("refuses a foreground host whose service is enabled but not running", async () => {
    expect(await upgradeBlocker("/data", { packaged: true, manager: manager({ running: false }) })).toBe("no-service");
  });

  it("refuses a service for another data dir, a stopped one, and a source checkout", async () => {
    expect(await upgradeBlocker("/other", { packaged: true, manager: manager({}) })).toBe("no-service");
    expect(await upgradeBlocker("/data", { packaged: true, manager: manager({ stopped: true, running: false }) })).toBe("stopped");
    expect(await upgradeBlocker("/data", { packaged: false, manager: manager({}) })).toBe("source");
  });
});
