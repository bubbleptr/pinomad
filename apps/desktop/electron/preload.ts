// Sandboxed preload: ipcRenderer.invoke reaches only the pinomad:hosts:*,
// pinomad:account:*, pinomad:updates:* and pinomad:device:name handlers in
// main (the paired-host list behind safeStorage, the app updater, and the
// pairing-time device label), and the document marker tells the renderer which
// platform owns the window — the renderer has no Node `process`. Copied from
// Pace's pattern.
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../web/src/entities/host/desktop-bridge.ts";
import { updateEventChannel, type UpdateStatus } from "../../web/src/entities/app-update/update-protocol.ts";

const bridge: DesktopBridge = {
  hosts: {
    list: () => ipcRenderer.invoke("pinomad:hosts:list"),
    save: (host) => ipcRenderer.invoke("pinomad:hosts:save", host),
    remove: (hostKey) => ipcRenderer.invoke("pinomad:hosts:remove", hostKey),
    setName: (hostKey, name) => ipcRenderer.invoke("pinomad:hosts:setName", { hostKey, name }),
    updateEndpoints: (hostKey, endpointSet) =>
      ipcRenderer.invoke("pinomad:hosts:updateEndpoints", { hostKey, endpointSet }),
    updateConnection: (hostKey, change) =>
      ipcRenderer.invoke("pinomad:hosts:updateConnection", { hostKey, change }),
  },
  account: {
    get: () => ipcRenderer.invoke("pinomad:account:get"),
    save: (account) => ipcRenderer.invoke("pinomad:account:save", account),
    clear: () => ipcRenderer.invoke("pinomad:account:clear"),
  },
  deviceName: () => ipcRenderer.invoke("pinomad:device:name"),
  updates: {
    status: () => ipcRenderer.invoke("pinomad:updates:status"),
    check: () => ipcRenderer.invoke("pinomad:updates:check"),
    install: () => ipcRenderer.invoke("pinomad:updates:install"),
    onStatus(listener: (status: UpdateStatus) => void) {
      const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => {
        listener(status);
      };
      ipcRenderer.on(updateEventChannel, handler);
      return () => {
        ipcRenderer.removeListener(updateEventChannel, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("pinomadDesktop", bridge);

function markHostDocument(): void {
  const root = document.documentElement;
  if (!root) {
    // HTTP dev pages can run the preload before the HTML root is parsed.
    return;
  }
  root.dataset.pinomadPlatform = process.platform;
  // The macOS window is vibrated (window-chrome.ts); the renderer clears its
  // own backgrounds under the sidebar only when this marker is present.
  if (process.platform === "darwin") root.setAttribute("data-pinomad-vibrancy", "");
}

markHostDocument();
window.addEventListener("DOMContentLoaded", markHostDocument, { once: true });
