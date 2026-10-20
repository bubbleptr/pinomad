import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { installAppMenu, reportUpdateCheck } from "./app-menu.ts";
import { pairingFragmentFromDeepLink } from "./deep-link.ts";
import { desktopDeviceName } from "./device-name.ts";
import { createHostStore, type StoredAccount, type StoredHost } from "./host-store.ts";
import { navigateAwayAction, windowOpenAction } from "./navigation-policy.ts";
import { APP_HOST, APP_SCHEME, contentTypeFor, rendererFilePath, RENDERER_CSP } from "./renderer-files.ts";
import { createAppUpdater, type AppUpdater, type AutoUpdaterLike } from "./updater.ts";
import { platformWindowChrome } from "./window-chrome.ts";
import { updateEventChannel } from "../../web/src/entities/app-update/update-protocol.ts";

const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const rendererDirectory = fileURLToPath(new URL("../renderer", import.meta.url));

let mainWindow: BrowserWindow | null = null;
// A cold launch from a link fires open-url before the window exists.
let pendingFragment: string | undefined;

// A dedicated scheme keeps the bundled UI off http:// while staying a real
// origin: localStorage persists per origin, and relative URLs just work.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function rendererEntry(): string {
  // electron-vite dev sets this; production serves the bundle over app://.
  return process.env.ELECTRON_RENDERER_URL ?? `${APP_ORIGIN}/index.html`;
}

function entryWithFragment(fragment?: string): string {
  const base = rendererEntry().split("#")[0]!;
  return fragment === undefined ? base : `${base}#${fragment}`;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 720,
    title: "PiNomad",
    ...platformWindowChrome(process.platform),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;

  const { webContents } = window;
  webContents.setWindowOpenHandler(({ url }) => {
    if (windowOpenAction(url) === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    const action = navigateAwayAction(webContents.getURL(), url);
    if (action === "allow") return;
    event.preventDefault();
    if (action === "external") void shell.openExternal(url);
  });
  window.on("closed", () => {
    mainWindow = null;
  });

  const fragment = pendingFragment;
  pendingFragment = undefined;
  void window.loadURL(entryWithFragment(fragment));
  return window;
}

const devEntry = process.env.ELECTRON_RENDERER_URL;

/** Every privileged invoke channel shares this caller check. */
function isOurRendererFrame(event: IpcMainInvokeEvent): boolean {
  // Only the window's top-level frame may reach privileged IPC. Subframes get
  // no preload today; this keeps an embedded frame out even if that changes.
  if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) return false;
  const url = event.senderFrame.url;
  if (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`)) return true;
  return devEntry !== undefined && (url === devEntry || url.startsWith(`${devEntry}/`));
}

/**
 * The paired-host list lives in the main process behind safeStorage; the
 * sandboxed renderer reaches it only through these invoke channels. Each
 * handler fails closed: a frame that isn't our own bundle (or the dev server)
 * is refused, and without keychain encryption nothing is stored — never
 * plaintext on disk.
 */
function installHostStoreIpc(): void {
  const hosts = createHostStore(app.getPath("userData"), {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  const handle = <A, R>(fn: (arg: A) => Promise<R>) => {
    return (event: IpcMainInvokeEvent, arg: A): Promise<R> => {
      if (!isOurRendererFrame(event)) return Promise.reject(new Error("host store is only reachable from the bundled renderer"));
      if (!safeStorage.isEncryptionAvailable()) return Promise.reject(new Error("safeStorage encryption is unavailable"));
      return fn(arg);
    };
  };
  ipcMain.handle("pinomad:hosts:list", handle(() => hosts.list()));
  ipcMain.handle("pinomad:hosts:save", handle((host: StoredHost) => hosts.save(host)));
  ipcMain.handle("pinomad:hosts:remove", handle((hostKey: string) => hosts.remove(hostKey)));
  ipcMain.handle("pinomad:hosts:setName", handle((args: { hostKey: string; name: string }) => hosts.setName(args.hostKey, args.name)));
  // The account session rides the same encrypted store and caller check.
  ipcMain.handle("pinomad:account:get", handle(() => hosts.account()));
  ipcMain.handle("pinomad:account:save", handle((account: StoredAccount) => hosts.saveAccount(account)));
  ipcMain.handle("pinomad:account:clear", handle(() => hosts.clearAccount()));
}

/**
 * The updater's invoke channels share the host store's caller check but not
 * its safeStorage requirement — read-only status and a restart ask for no
 * keychain. Status changes are pushed over `pinomad:updates:event` instead.
 */
function installUpdateIpc(updater: AppUpdater): void {
  const handle = (fn: () => unknown) => {
    return (event: IpcMainInvokeEvent): Promise<unknown> => {
      if (!isOurRendererFrame(event)) return Promise.reject(new Error("updates are only reachable from the bundled renderer"));
      return Promise.resolve(fn());
    };
  };
  ipcMain.handle("pinomad:updates:status", handle(() => updater.getStatus()));
  ipcMain.handle("pinomad:updates:check", handle(() => updater.check()));
  ipcMain.handle("pinomad:updates:install", handle(() => updater.install()));
}

/**
 * The pairing-time device label the renderer asks for. Shares the caller
 * check but not safeStorage — a hostname isn't a secret, and pairing must
 * name itself even with a locked keychain.
 */
function installDeviceNameIpc(): void {
  ipcMain.handle("pinomad:device:name", (event: IpcMainInvokeEvent) => {
    if (!isOurRendererFrame(event)) {
      return Promise.reject(new Error("the device name is only reachable from the bundled renderer"));
    }
    return Promise.resolve(desktopDeviceName(process.platform, hostname()));
  });
}

function openPairingLink(fragment: string): void {
  if (mainWindow === null) {
    pendingFragment = fragment;
    if (app.isReady()) createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  void mainWindow.loadURL(entryWithFragment(fragment));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("PiNomad");
  // E2E isolation: the renderer's paired device lives in userData localStorage;
  // macOS derives it from the system Library, not $HOME, so tests need this.
  if (process.env.PINOMAD_USER_DATA_DIR !== undefined) {
    app.setPath("userData", process.env.PINOMAD_USER_DATA_DIR);
  }
  // Inside the .app the Info.plist registration does this; the call only
  // matters for unpackaged launches, where it may not stick.
  if (app.isPackaged) app.setAsDefaultProtocolClient("pinomad");

  app.on("second-instance", (_event, argv) => {
    // Windows/Linux pass the deep link through argv; macOS uses open-url.
    const link = argv.find((arg) => arg.startsWith("pinomad:"));
    const fragment = link === undefined ? undefined : pairingFragmentFromDeepLink(link);
    if (fragment !== undefined) {
      openPairingLink(fragment);
    } else if (mainWindow !== null) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const fragment = pairingFragmentFromDeepLink(url);
    if (fragment !== undefined) openPairingLink(fragment);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (mainWindow === null) createMainWindow();
  });

  void app.whenReady().then(() => {
    // Unpackaged runs (today's desktop:e2e included) are already disabled by
    // !isPackaged; PINOMAD_E2E exists in case an E2E ever drives a packaged
    // build, where isPackaged is true and it would hit GitHub 10s in.
    const updater = createAppUpdater({
      // electron-updater's typed `on` only accepts its event map; the updater
      // seam takes a stringly EventEmitter-shaped client so tests inject one.
      autoUpdater: autoUpdater as AutoUpdaterLike,
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion(),
      disabledReason:
        process.env.PINOMAD_E2E === "1" ? "Updates are disabled during end-to-end tests." : undefined,
    });
    updater.subscribe((status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(updateEventChannel, status);
      }
    });
    installUpdateIpc(updater);
    installAppMenu({
      menu: Menu,
      updater,
      onCheckForUpdates: () =>
        reportUpdateCheck(updater, (message) => {
          void dialog.showMessageBox({ type: "info", message });
        }),
    });
    installHostStoreIpc();
    installDeviceNameIpc();
    protocol.handle(APP_SCHEME, async (request) => {
      const file = rendererFilePath(rendererDirectory, request.url);
      if (file === undefined) return new Response("Not found", { status: 404 });
      try {
        const body = await readFile(file);
        return new Response(new Uint8Array(body), {
          headers: {
            "content-type": contentTypeFor(file),
            "content-security-policy": RENDERER_CSP,
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
    createMainWindow();
    updater.start();
  });
}
