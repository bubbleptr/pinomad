import { afterEach, describe, expect, it } from "vitest";
import { accountDeviceName, clientDeviceName, deviceName } from "./address.ts";
import type { DesktopBridge } from "./entities/host/desktop-bridge.ts";

describe("accountDeviceName", () => {
  it("names a browser from its UA and the desktop app by platform, never by hostname", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    expect(accountDeviceName(mac)).toBe("Mac Chrome");
    expect(accountDeviceName(mac, "darwin")).toBe("Mac Desktop");
    expect(accountDeviceName(mac, "linux")).toBe("Linux Desktop");
    expect(accountDeviceName(mac, "aix")).toBe("Desktop");
  });
});

describe("clientDeviceName", () => {
  afterEach(() => {
    delete window.pinomadDesktop;
  });

  it("prefers the desktop bridge's machine-aware name", async () => {
    window.pinomadDesktop = {
      deviceName: () => Promise.resolve("Mac Desktop (kieran-mbp)"),
    } as unknown as DesktopBridge;
    await expect(clientDeviceName()).resolves.toBe("Mac Desktop (kieran-mbp)");
  });

  it("falls back to the UA-derived name when the bridge can't answer", async () => {
    window.pinomadDesktop = {
      deviceName: () => Promise.reject(new Error("no handler")),
    } as unknown as DesktopBridge;
    await expect(clientDeviceName()).resolves.toBe(deviceName(navigator.userAgent));
  });

  it("derives the name from the UA in a plain browser", async () => {
    await expect(clientDeviceName()).resolves.toBe(deviceName(navigator.userAgent));
  });
});
