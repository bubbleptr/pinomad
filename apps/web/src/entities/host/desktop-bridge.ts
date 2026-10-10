import type { StoredHost } from "./host-store.ts";

/**
 * What the desktop preload exposes on `window.pinomadDesktop`. The paired
 * hosts live in the Electron main process behind safeStorage; these invoke
 * channels are the renderer's only reach to them. The preload imports this
 * type so the two sides can't drift apart.
 */
export interface DesktopBridge {
  readonly hosts: {
    list(): Promise<StoredHost[]>;
    save(host: StoredHost): Promise<void>;
    remove(hostKey: string): Promise<void>;
  };
}

declare global {
  interface Window {
    pinomadDesktop?: DesktopBridge;
  }
}
