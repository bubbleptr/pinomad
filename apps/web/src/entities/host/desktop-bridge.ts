import type { UpdateStatus } from "../app-update/update-protocol.ts";
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
    /** Cache the machine name the host announced (5.12); writes nothing when the entry is gone. */
    setName(hostKey: string, name: string): Promise<void>;
  };
  /**
   * The bearer credential for the server-accounts API, kept in main's
   * encrypted store (ADR-0022). Optional like `updates`: older bridges lack
   * it, and a build without it just can't persist a session.
   */
  readonly account?: {
    get(): Promise<{ serverOrigin: string; token: string } | undefined>;
    save(account: { serverOrigin: string; token: string }): Promise<void>;
    clear(): Promise<void>;
  };
  /**
   * The label pairing registers on the host's device list ("Mac Desktop
   * (kieran-mbp)"). Optional like `updates`: the browser has no bridge, and a
   * missing one just falls back to the UA-derived name.
   */
  readonly deviceName?: () => Promise<string>;
  /**
   * Electron-updater control, owned by main. Optional only because the
   * browser has no bridge at all — inside the desktop app it always exists.
   */
  readonly updates?: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    install(): Promise<UpdateStatus>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    pinomadDesktop?: DesktopBridge;
  }
}
