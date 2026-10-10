import { app, BrowserWindow, Menu, protocol, shell } from "electron";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installAppMenu } from "./app-menu.ts";
import { pairingFragmentFromDeepLink } from "./deep-link.ts";
import { navigateAwayAction, windowOpenAction } from "./navigation-policy.ts";
import { contentTypeFor, rendererFilePath, RENDERER_CSP } from "./renderer-files.ts";
import { platformWindowChrome } from "./window-chrome.ts";

const APP_SCHEME = "app";
const APP_ORIGIN = "app://pinomad";
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
