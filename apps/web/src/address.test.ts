import { afterEach, describe, expect, it } from "vitest";
import { clientDeviceName, deviceName } from "./address.ts";
import type { DesktopBridge } from "./entities/host/desktop-bridge.ts";

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
