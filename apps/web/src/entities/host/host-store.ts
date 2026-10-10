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
  // One-shot migration: a device paired before multi-host existed moves from
  // localStorage into the encrypted list. Keeping the session usable even if
  // the save fails — the next launch retries.
  let migrated = false;
  return {
    multiHost: true,
    list: async () => {
      const hosts = await bridge.hosts.list();
      if (migrated || hosts.length > 0) return hosts;
      migrated = true;
      const legacy = storedDevice(localStorage.getItem(DEVICE_KEY));
      if (legacy === undefined) return hosts;
      try {
        await bridge.hosts.save(legacy);
        localStorage.removeItem(DEVICE_KEY);
      } catch (error) {
        console.error("Could not migrate the stored device into the desktop host list", error);
      }
      return [legacy];
    },
    save: (host) => bridge.hosts.save(host),
    remove: (hostKey) => bridge.hosts.remove(hostKey),
  };
}

export function hostStore(): HostStore {
  const bridge: DesktopBridge | undefined = window.pinomadDesktop;
  return bridge === undefined ? browserStore : desktopStore(bridge);
}

/**
 * Sidebar/menu label per host: the URL's host, disambiguated by the hostKey
 * prefix when two hosts share one (e.g. two hosts behind the same relay).
 */
export function hostLabels(hosts: readonly StoredHost[]): Map<string, string> {
  const base = (host: StoredHost): string => {
    try {
      return new URL(host.url).host;
    } catch {
      return host.url;
    }
  };
  const counts = new Map<string, number>();
  for (const host of hosts) counts.set(base(host), (counts.get(base(host)) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const host of hosts) {
    const label = base(host);
    labels.set(host.hostKey, counts.get(label)! > 1 ? `${label} · ${host.hostKey.slice(0, 6)}` : label);
  }
  return labels;
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
