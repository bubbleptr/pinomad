import { describe, expect, it } from "vitest";
import { desktopDeviceName } from "../electron/device-name.ts";

describe("desktopDeviceName", () => {
  it("names the OS family with the hostname", () => {
    expect(desktopDeviceName("darwin", "kieran-mbp")).toBe("Mac Desktop (kieran-mbp)");
    expect(desktopDeviceName("win32", "DESKTOP-42")).toBe("Windows Desktop (DESKTOP-42)");
    expect(desktopDeviceName("linux", "omarchy")).toBe("Linux Desktop (omarchy)");
  });

  it("drops the hostname part when the OS reports none", () => {
    expect(desktopDeviceName("darwin", "")).toBe("Mac Desktop");
  });

  it("still calls itself a desktop on an unlisted platform", () => {
    expect(desktopDeviceName("freebsd", "box")).toBe("Desktop (box)");
    expect(desktopDeviceName("freebsd", "")).toBe("Desktop");
  });
});
