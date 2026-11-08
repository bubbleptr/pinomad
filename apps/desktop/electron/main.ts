import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installAppMenu, reportUpdateCheck } from "./app-menu.ts";
import { pairingFragmentFromDeepLink } from "./deep-link.ts";
import { devRequestHeaders, devResponseHeaders } from "./dev-origin.ts";
import { desktopDeviceName } from "./device-name.ts";
import { createHostStore, type StoredAccount, type StoredHost } from "./host-store.ts";
import { createLocalHost, type LocalHost } from "./local-host.ts";
import { LAUNCHER_EXECUTABLE } from "../../host/src/service/definition.ts";
import { navigateAwayAction, windowOpenAction } from "./navigation-policy.ts";
import { loopbackLinks, loopbackSignIn, type LoopbackSignInInput } from "./oauth-loopback.ts";
import { APP_HOST, APP_SCHEME, contentTypeFor, rendererFilePath, RENDERER_CSP } from "./renderer-files.ts";
import { createAppUpdater, type AppUpdater, type AutoUpdaterLike } from "./updater.ts";
import { desktopUserDataDir } from "./user-data.ts";
import { platformWindowChrome } from "./window-chrome.ts";
import type { StoredHostConnectionChange } from "@pinomad/client/stored-host.ts";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { updateEventChannel } from "../../web/src/entities/app-update/update-protocol.ts";
import {
  localHostSetupLinesChannel,
  localHostStopLinesChannel,
} from "../../web/src/entities/local-host/local-host-protocol.ts";

const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/**
 * The host launcher afterPack built into this app (host-launcher/), offered
 * only from Applications: a plist pointing into a disk image, Downloads, or
 * a translocated copy breaks once that copy goes away.
 */
function hostLauncher(): string | undefined {
  if (!app.isPackaged || !app.isInApplicationsFolder()) return undefined;
  const path = join(dirname(app.getPath("exe")), "..", "Helpers", "PiNomad Host.app", "Contents", "MacOS", LAUNCHER_EXECUTABLE);
  return existsSync(path) ? path : undefined;
}

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

/** Dev only: the account server must see the dev renderer as app://pinomad (dev-origin.ts). */
function installDevOriginRewrite(devOrigin: string): void {
  const { webRequest } = session.defaultSession;
  // The account API is https-only; Vite's HMR socket and host ws(s):// links keep their real Origin.
  const filter = { urls: ["https://*/*"] };
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const requestHeaders = devRequestHeaders(details.requestHeaders, devOrigin, APP_ORIGIN);
    callback(requestHeaders === undefined ? {} : { requestHeaders });
  });
  webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = details.responseHeaders && devResponseHeaders(details.responseHeaders, devOrigin, APP_ORIGIN);
    callback(responseHeaders === undefined ? {} : { responseHeaders });
  });
}

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
  ipcMain.handle(
    "pinomad:hosts:updateEndpoints",
    handle((args: { hostKey: string; endpointSet: EndpointSet }) => hosts.updateEndpoints(args.hostKey, args.endpointSet)),
  );
  ipcMain.handle(
    "pinomad:hosts:updateConnection",
    handle((args: { hostKey: string; change: StoredHostConnectionChange }) =>
      hosts.updateConnection(args.hostKey, args.change),
    ),
  );
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

/**
 * Provider sign-in (ADR-0044 §5): main owns the 127.0.0.1 listener and the
 * system browser; the renderer keeps the PKCE verifier and trades the code
 * itself. Same caller check, no safeStorage. A finished sign-in brings the
 * window back in front of the browser.
 */
function installOAuthIpc(): void {
  const openExternal = (url: string): Promise<void> => shell.openExternal(url);
  const toFront = (): void => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  };
  ipcMain.handle("pinomad:oauth:signIn", async (event: IpcMainInvokeEvent, input: LoopbackSignInInput) => {
    if (!isOurRendererFrame(event)) throw new Error("sign-in is only reachable from the bundled renderer");
    const result = await loopbackSignIn(input, { openExternal });
    if ("code" in result) toFront();
    return result;
  });
  // Linking a provider from settings (#631): listen first, so the renderer
  // can give the server its redirect, then open the URL the server answered.
  const links = loopbackLinks({ openExternal });
  ipcMain.handle("pinomad:oauth:linkListen", (event: IpcMainInvokeEvent, input: { serverOrigin: string; state: string }) => {
    if (!isOurRendererFrame(event)) throw new Error("linking is only reachable from the bundled renderer");
    return links.listen(input);
  });
  ipcMain.handle("pinomad:oauth:linkOpen", async (event: IpcMainInvokeEvent, input: { state: string; url: string }) => {
    if (!isOurRendererFrame(event)) throw new Error("linking is only reachable from the bundled renderer");
    const result = await links.open(input);
    if ("code" in result) toFront();
    return result;
  });
}

/**
 * The "This Mac" host switch (#501), macOS only: main runs the installed
 * host's own service CLI (local-host.ts), never a host of its own. Same caller
 * check, no safeStorage. Nothing here runs until the renderer asks, so a
 * launch (E2E included) never touches the real service.
 */
function installLocalHostIpc(localHost: LocalHost): void {
  const handle = <A, R>(fn: (event: IpcMainInvokeEvent, arg: A) => Promise<R> | R) => {
    return (event: IpcMainInvokeEvent, arg: A): Promise<R> => {
      if (!isOurRendererFrame(event)) return Promise.reject(new Error("the local host is only reachable from the bundled renderer"));
      return Promise.resolve(fn(event, arg));
    };
  };
  ipcMain.handle("pinomad:localHost:state", handle(() => localHost.state()));
  ipcMain.handle("pinomad:localHost:start", handle(() => localHost.start()));
  // Lines go back to the window that asked: it is the one showing Cancel.
  const linesTo = (event: IpcMainInvokeEvent) => (lines: readonly string[]) => {
    if (!event.sender.isDestroyed()) event.sender.send(localHostStopLinesChannel, lines);
  };
  ipcMain.handle("pinomad:localHost:stop", handle((event) => localHost.stop(linesTo(event))));
  ipcMain.handle("pinomad:localHost:followStop", handle((event) => localHost.followStop(linesTo(event))));
  ipcMain.handle("pinomad:localHost:cancelStop", handle(() => localHost.cancelStop()));
  const setupLinesTo = (event: IpcMainInvokeEvent) => (lines: readonly string[]) => {
    if (!event.sender.isDestroyed()) event.sender.send(localHostSetupLinesChannel, lines);
  };
  ipcMain.handle("pinomad:localHost:install", handle((event) => localHost.install(setupLinesTo(event))));
  ipcMain.handle("pinomad:localHost:cancelInstall", handle(() => localHost.cancelInstall()));
  ipcMain.handle(
    "pinomad:localHost:join",
    handle((_event, arg: { serverOrigin?: unknown; token?: unknown } | undefined) =>
      localHost.join(String(arg?.serverOrigin), String(arg?.token)),
    ),
  );
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

// The single-instance lock is stored inside userData, so this has to land
// before the lock is requested: otherwise dev and installed builds compete for
// the same lock and one quits. Separate directories also keep a dev run from
// rewriting the real host list and renderer localStorage. No migration — hosts
// paired in a dev build before this need pairing again. The override comes
// first so E2E can still use a throwaway directory (on macOS the renderer's
// paired device lives in the system Library, not $HOME).
const defaultUserDataDir = app.getPath("userData");
const userDataDir = desktopUserDataDir({
  defaultDir: defaultUserDataDir,
  isPackaged: app.isPackaged,
  override: process.env.PINOMAD_USER_DATA_DIR,
});
if (userDataDir !== defaultUserDataDir) {
  // setPath throws when the directory is missing, and the -dev sibling does
  // not exist on the first development launch.
  mkdirSync(userDataDir, { recursive: true });
  app.setPath("userData", userDataDir);
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
    if (devEntry !== undefined) installDevOriginRewrite(new URL(devEntry).origin);
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
    installOAuthIpc();
    if (process.platform === "darwin") {
      const localHost = createLocalHost({
        home: homedir(),
        env: process.env,
        execFile: promisify(execFile),
        spawn: (file, args, options) => spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }),
        // Chromium's network stack: the system proxy applies, as it does to curl in Terminal.
        fetchText: async (url) => {
          const response = await net.fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        },
        killGroup: (pid, signal) => process.kill(-pid, signal),
        launcher: hostLauncher(),
      });
      installLocalHostIpc(localHost);
      // A stop still waiting when the app quits is cancelled: the service stays on.
      // A detached install would outlive the app: it goes too, and a re-run replaces what it left.
      app.on("will-quit", () => {
        localHost.cancelStop();
        localHost.cancelInstall();
      });
    }
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
