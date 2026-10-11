import { createContext, useContext } from "react";
import { DEVICE_KEY, storedDevice, type StoredHost } from "../../address.ts";
import type { DesktopBridge } from "./desktop-bridge.ts";

export type { StoredHost };

/** localStorage key naming the host the sidebar last connected to (a UI pref, not a secret). */
export const ACTIVE_HOST_KEY = "pinomad.activeHost";

/**
 * Where paired hosts live. The browser keeps a single device in localStorage
 * (multiHost false: pairing elsewhere replaces it); the desktop delegates to
 * the main process's encrypted list via the preload bridge.
 */
export interface HostStore {
  readonly multiHost: boolean;
  list(): Promise<StoredHost[]>;
  /** Browser: replaces the one stored device. Desktop: upserts by hostKey. */
  save(host: StoredHost): Promise<void>;
  remove(hostKey: string): Promise<void>;
}

const browserStore: HostStore = {
  multiHost: false,
  list: () => {
    const device = storedDevice(localStorage.getItem(DEVICE_KEY));
    return Promise.resolve(device === undefined ? [] : [device]);
  },
  save: (host) => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(host));
    return Promise.resolve();
  },
  remove: (hostKey) => {
    const device = storedDevice(localStorage.getItem(DEVICE_KEY));
    if (device !== undefined && device.hostKey === hostKey) localStorage.removeItem(DEVICE_KEY);
    return Promise.resolve();
  },
};

function desktopStore(bridge: DesktopBridge): HostStore {
  // One-shot migration, shared across concurrent list() calls: a device paired
  // before multi-host existed merges into the encrypted list and its legacy
  // key is retired. A failed save keeps the key so the next launch retries —
  // for this session the entry is merged into every list() answer instead.
  let migration: Promise<StoredHost | undefined> | undefined;
  const migrate = async (): Promise<StoredHost | undefined> => {
    const legacy = storedDevice(localStorage.getItem(DEVICE_KEY));
    if (legacy === undefined) return undefined;
    try {
      const hosts = await bridge.hosts.list();
      // The encrypted list wins for the same host: legacy may hold an older key.
      if (!hosts.some((entry) => entry.hostKey === legacy.hostKey)) await bridge.hosts.save(legacy);
      localStorage.removeItem(DEVICE_KEY);
      return undefined;
    } catch (error) {
      console.error("Could not migrate the stored device into the desktop host list", error);
      return legacy;
    }
  };
  return {
    multiHost: true,
    list: async () => {
      const unsaved = await (migration ??= migrate());
      const hosts = await bridge.hosts.list();
      return unsaved === undefined || hosts.some((entry) => entry.hostKey === unsaved.hostKey)
        ? hosts
        : [...hosts, unsaved];
    },
    save: (host) => bridge.hosts.save(host),
    remove: (hostKey) => bridge.hosts.remove(hostKey),
  };
}

export function hostStore(): HostStore {
  const bridge: DesktopBridge | undefined = window.pinomadDesktop;
  return bridge === undefined ? browserStore : desktopStore(bridge);
}

/** What App loaded once: the store plus the snapshot the whole render shares. */
export type HostsState = {
  readonly store: HostStore;
  readonly hosts: readonly StoredHost[];
  readonly activeHostKey: string | null;
  /** Persist a new pairing, mark it active, and update the in-memory list. */
  readonly paired: (host: StoredHost) => Promise<void>;
};

const defaultState: HostsState = {
  store: browserStore,
  hosts: [],
  activeHostKey: null,
  paired: (host) => browserStore.save(host),
};

// Deep components — the sidebar footer, the connection-failure screens — read
// this instead of threading the host list through every layer.
export const HostsContext = createContext<HostsState>(defaultState);
export const useHosts = (): HostsState => useContext(HostsContext);
