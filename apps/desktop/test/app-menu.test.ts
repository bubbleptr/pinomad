import { describe, expect, it, vi } from "vitest";
import { buildAppMenuTemplate, reportUpdateCheck, updateCheckDialog } from "../electron/app-menu.ts";
import type { UpdateStatus } from "../../web/src/entities/app-update/update-protocol.ts";
import type { AppUpdater } from "../electron/updater.ts";

const status = (over: Partial<UpdateStatus>): UpdateStatus => ({ state: "idle", currentVersion: "0.1.0", ...over });

function checkMenuItem() {
  const template = buildAppMenuTemplate({
    platform: "darwin",
    updatesEnabled: true,
    onCheckForUpdates: () => {},
  });
  const appMenu = template[0]!.submenu as Electron.MenuItemConstructorOptions[];
  return appMenu.find((item) => item.label === "Check for Updates…");
}

describe("buildAppMenuTemplate", () => {
  it("has no application menu off darwin", () => {
    expect(
      buildAppMenuTemplate({ platform: "linux", updatesEnabled: true, onCheckForUpdates: () => {} }),
    ).toEqual([]);
  });

  it("offers Check for Updates right after About and wires the click", () => {
    const check = vi.fn();
    const template = buildAppMenuTemplate({ platform: "darwin", updatesEnabled: true, onCheckForUpdates: check });
    const appMenu = template[0]!.submenu as Electron.MenuItemConstructorOptions[];
    const index = appMenu.findIndex((item) => item.label === "Check for Updates…");
    expect(index).toBe(1); // About is index 0.
    appMenu[index]!.click?.({} as Electron.MenuItem, {} as Electron.BaseWindow, {} as Electron.KeyboardEvent);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("disables Check for Updates when the updater is disabled", () => {
    expect(
      buildAppMenuTemplate({ platform: "darwin", updatesEnabled: false, onCheckForUpdates: () => {} })
        [0]!.submenu as Electron.MenuItemConstructorOptions[],
    ).toContainEqual(expect.objectContaining({ label: "Check for Updates…", enabled: false }));
  });
});

describe("updateCheckDialog", () => {
  it("stays silent while the check is in flight", () => {
    expect(updateCheckDialog(status({ state: "checking" }))).toBeUndefined();
  });

  it("reports up to date once the check settles on idle", () => {
    expect(updateCheckDialog(status({ state: "idle" }))).toContain("0.1.0");
  });

  it("points at the sidebar button for available and downloading updates", () => {
    for (const state of ["available", "downloading"] as const) {
      expect(updateCheckDialog(status({ state, availableVersion: "0.2.0" }))).toContain("0.2.0");
      expect(updateCheckDialog(status({ state, availableVersion: "0.2.0" }))).toContain("sidebar");
    }
  });

  it("points at the sidebar button for a downloaded update", () => {
    expect(updateCheckDialog(status({ state: "ready", availableVersion: "0.2.0" }))).toContain("0.2.0");
  });

  it("surfaces the updater's error message", () => {
    expect(updateCheckDialog(status({ state: "error", message: "network down" }))).toBe("network down");
  });
});

describe("reportUpdateCheck", () => {
  const fakeUpdater = (initial: UpdateStatus) => {
    const listeners = new Set<(s: UpdateStatus) => void>();
    return {
      status: initial,
      check: vi.fn(() => initial),
      subscribe: (listener: (s: UpdateStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (s: UpdateStatus) => {
        for (const listener of [...listeners]) listener(s);
      },
    };
  };

  it("reports immediately when the status already maps to a dialog", () => {
    const updater = fakeUpdater(status({ state: "ready", availableVersion: "0.2.0" }));
    const shown: string[] = [];
    reportUpdateCheck(updater as unknown as Pick<AppUpdater, "check" | "subscribe">, (m) => shown.push(m));
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("0.2.0");
  });

  it("waits through checking and reports the settled state once", () => {
    const updater = fakeUpdater(status({ state: "checking" }));
    const shown: string[] = [];
    reportUpdateCheck(updater as unknown as Pick<AppUpdater, "check" | "subscribe">, (m) => shown.push(m));
    expect(shown).toEqual([]);

    updater.emit(status({ state: "checking" }));
    expect(shown).toEqual([]);

    updater.emit(status({ state: "idle" }));
    updater.emit(status({ state: "idle" })); // unsubscribed after the first report
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("0.1.0");
  });
});
