import type { MenuItemConstructorOptions } from "electron";

/**
 * Pace's darwin menu minus the updater item (auto-update is a later PR).
 * Other platforms keep Electron's default menu.
 */
export function buildAppMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  if (platform !== "darwin") return [];
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
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

/** Menu is injected so the pure template above stays unit-testable. */
export function installAppMenu(menu: {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Electron.Menu;
  setApplicationMenu(menu: Electron.Menu | null): void;
}): void {
  const template = buildAppMenuTemplate(process.platform);
  if (template.length === 0) return;
  menu.setApplicationMenu(menu.buildFromTemplate(template));
}
