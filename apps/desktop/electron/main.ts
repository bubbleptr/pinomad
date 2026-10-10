import { app, BrowserWindow, ipcMain, Menu, protocol, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installAppMenu } from "./app-menu.ts";
import { pairingFragmentFromDeepLink } from "./deep-link.ts";
import { createHostStore, type StoredHost } from "./host-store.ts";
import { navigateAwayAction, windowOpenAction } from "./navigation-policy.ts";
import { APP_HOST, APP_SCHEME, contentTypeFor, rendererFilePath, RENDERER_CSP } from "./renderer-files.ts";
import { platformWindowChrome } from "./window-chrome.ts";

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
  const devEntry = process.env.ELECTRON_RENDERER_URL;
  const ours = (event: IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url ?? "";
    if (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`)) return true;
    return devEntry !== undefined && (url === devEntry || url.startsWith(`${devEntry}/`));
  };
  const handle = <A, R>(fn: (arg: A) => Promise<R>) => {
    return (event: IpcMainInvokeEvent, arg: A): Promise<R> => {
      if (!ours(event)) return Promise.reject(new Error("host store is only reachable from the bundled renderer"));
      if (!safeStorage.isEncryptionAvailable()) return Promise.reject(new Error("safeStorage encryption is unavailable"));
      return fn(arg);
    };
  };
  ipcMain.handle("pinomad:hosts:list", handle(() => hosts.list()));
  ipcMain.handle("pinomad:hosts:save", handle((host: StoredHost) => hosts.save(host)));
  ipcMain.handle("pinomad:hosts:remove", handle((hostKey: string) => hosts.remove(hostKey)));
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
    installAppMenu(Menu);
    installHostStoreIpc();
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
  });
}
