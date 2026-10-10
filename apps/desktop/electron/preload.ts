// Sandboxed preload: ipcRenderer.invoke reaches only the pinomad:hosts:*
// handlers in main (the paired-host list behind safeStorage), and the document
// marker tells the renderer which platform owns the window — the renderer has
// no Node `process`. Copied from Pace's pattern.
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../web/src/entities/host/desktop-bridge.ts";

const bridge: DesktopBridge = {
  hosts: {
    list: () => ipcRenderer.invoke("pinomad:hosts:list"),
    save: (host) => ipcRenderer.invoke("pinomad:hosts:save", host),
    remove: (hostKey) => ipcRenderer.invoke("pinomad:hosts:remove", hostKey),
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
}

markHostDocument();
window.addEventListener("DOMContentLoaded", markHostDocument, { once: true });
