import type { MenuItemConstructorOptions } from "electron";
import type { UpdateStatus } from "../../web/src/entities/app-update/update-protocol.ts";
import type { AppUpdater } from "./updater.ts";

/**
 * darwin app-menu plus a "Check for Updates…" item. Other platforms keep
 * Electron's default menu. The menu shape stays pure (no Electron import)
 * so unit tests can assert it; `installAppMenu` is the only function that
 * touches `Menu`.
 */
export function buildAppMenuTemplate({
  platform,
  updatesEnabled,
  onCheckForUpdates,
}: {
  platform: NodeJS.Platform;
  updatesEnabled: boolean;
  onCheckForUpdates: () => void;
}): MenuItemConstructorOptions[] {
  if (platform !== "darwin") return [];
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          enabled: updatesEnabled,
          click: onCheckForUpdates,
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

/**
 * The dialog text once a menu-initiated update check reaches a state worth
 * reporting; `undefined` while the check is still in flight. There is no
 * settings page — the menu click is the only user-initiated check, so its
 * outcome must be told back to the user. Timer-driven checks never come
 * through here and stay silent.
 */
export function updateCheckDialog(status: UpdateStatus): string | undefined {
  switch (status.state) {
    case "idle":
      return `PiNomad ${status.currentVersion} is the latest version.`;
    case "available":
    case "downloading":
      return `Version ${status.availableVersion ?? "unknown"} is downloading in the background; a Restart to update button will appear in the sidebar when it's ready.`;
    case "ready":
      return `PiNomad ${status.availableVersion ?? "the update"} is ready to install — use "Restart to update" in the sidebar.`;
    case "error":
      return status.message ?? "The update check failed.";
    case "disabled":
      return status.reason ?? "Updates are unavailable in this build.";
    default:
      return undefined;
  }
}

/**
 * Run a menu-initiated check and report its outcome. `check()` is a no-op
 * once a download is under way, so a status that already maps to a dialog
 * is shown immediately instead of subscribing for a change that will not
 * come. Otherwise the first settled status wins and the listener detaches.
 */
export function reportUpdateCheck(
  updater: Pick<AppUpdater, "check" | "subscribe">,
  showMessage: (message: string) => void,
): void {
  const report = (status: UpdateStatus): boolean => {
    const message = updateCheckDialog(status);
    if (message === undefined) return false;
    showMessage(message);
    return true;
  };
  if (report(updater.check())) return;
  const off = updater.subscribe((next) => {
    if (report(next)) off();
  });
}

/** Menu is injected so the pure template above stays unit-testable. */
export function installAppMenu(options: {
  menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): Electron.Menu;
    setApplicationMenu(menu: Electron.Menu | null): void;
  };
  updater: Pick<AppUpdater, "getStatus">;
  onCheckForUpdates: () => void;
}): void {
  const template = buildAppMenuTemplate({
    platform: process.platform,
    updatesEnabled: options.updater.getStatus().state !== "disabled",
    onCheckForUpdates: options.onCheckForUpdates,
  });
  if (template.length === 0) return;
  options.menu.setApplicationMenu(options.menu.buildFromTemplate(template));
}
