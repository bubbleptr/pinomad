import { describe, expect, it } from "vitest";
import { desktopUserDataDir } from "../electron/user-data.ts";

// The scoped package name is what Electron derives userData from before
// main.ts renames the app, on every platform it ships to.
const defaultDir = "/home/user/.config/@pinomad/desktop";

describe("desktopUserDataDir", () => {
  it("keeps the default directory for a packaged app", () => {
    expect(desktopUserDataDir({ defaultDir, isPackaged: true })).toBe(defaultDir);
  });

  it("moves an unpackaged app to the default's -dev sibling", () => {
    expect(desktopUserDataDir({ defaultDir, isPackaged: false })).toBe(
      "/home/user/.config/@pinomad/desktop-dev",
    );
  });

  it("lets the override win in both editions", () => {
    expect(desktopUserDataDir({ defaultDir, isPackaged: false, override: "/tmp/pinomad-e2e" })).toBe(
      "/tmp/pinomad-e2e",
    );
    expect(desktopUserDataDir({ defaultDir, isPackaged: true, override: "/tmp/pinomad-e2e" })).toBe(
      "/tmp/pinomad-e2e",
    );
  });
});
