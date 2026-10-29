import { createContext, useContext, useEffect } from "react";
import {
  mergeStoredHost,
  parseStoredHost,
  updateStoredHostConnection,
  updateStoredHostEndpoints,
  type StoredHostConnectionChange,
} from "@pinomad/client/stored-host.ts";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import type { HostSettings } from "@pinomad/protocol/settings.ts";
import { DEVICE_KEY, storedDevice, type StoredHost } from "../../address.ts";
import type { ConversationRef, HostFocus } from "./focus.ts";
import type { DesktopBridge } from "./desktop-bridge.ts";

export type { StoredHost };

/** localStorage key holding the browser's paired hosts as a JSON array. */
export const HOSTS_KEY = "pinomad.hosts";

/**
 * Where paired hosts live. The browser keeps its list in localStorage; the
 * desktop delegates to the main process's encrypted list via the preload
 * bridge. Both upsert by hostKey: pairing another host adds to the list.
 */
export interface HostStore {
  list(): Promise<StoredHost[]>;
  save(host: StoredHost): Promise<void>;
  remove(hostKey: string): Promise<void>;
  /**
   * Cache the machine name the host announced (5.12): updates only `name`,
   * leaves every other field, and writes nothing when the entry is gone —
   * a name arriving after a forget must not resurrect the pairing.
   */
  setName(hostKey: string, name: string): Promise<void>;
  /**
   * Apply a host-published remote set by hostKey: only endpoint fields move,
   * and a forgotten host is never resurrected. Serialized with every other
   * read-modify-write on the store.
   */
  updateEndpoints(hostKey: string, endpointSet: EndpointSet): Promise<void>;
  /**
   * Persist the connection mode or the learned signal-only hint in place.
   * Writes nothing when the host is gone, so a late hello cannot resurrect it.
   */
  updateConnection(hostKey: string, change: StoredHostConnectionChange): Promise<void>;
}

const readHosts = (): StoredHost[] => {
  const raw = localStorage.getItem(HOSTS_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const host = parseStoredHost(entry);
    return host === undefined ? [] : [host];
  });
};

const writeHosts = (hosts: readonly StoredHost[]): void => {
  localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
};

/**
 * The stored list with the legacy single-device record (DEVICE_KEY) folded
 * in and its key retired — the same migration the desktop store runs, only
 * synchronous because localStorage is. A failed write keeps the legacy key
 * so the next launch retries; this session still sees the entry.
 */
function migrated(): StoredHost[] {
  const hosts = readHosts();
  const legacy = storedDevice(localStorage.getItem(DEVICE_KEY));
  if (legacy === undefined) return hosts;
  if (hosts.some((entry) => entry.hostKey === legacy.hostKey)) {
    localStorage.removeItem(DEVICE_KEY);
    return hosts;
  }
  try {
    writeHosts([...hosts, legacy]);
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Leave DEVICE_KEY: the next launch retries the move.
  }
  return [...hosts, legacy];
}

const browserStore: HostStore = {
  list: () => Promise.resolve(migrated()),
  save: (host) => {
    const hosts = migrated();
    const existing = hosts.find((each) => each.hostKey === host.hostKey);
    writeHosts([
      ...hosts.filter((each) => each.hostKey !== host.hostKey),
      existing === undefined ? host : mergeStoredHost(existing, host),
    ]);
    return Promise.resolve();
  },
  remove: (hostKey) => {
    writeHosts(migrated().filter((each) => each.hostKey !== hostKey));
    // A legacy record that never migrated is still removed if it matches.
    const legacy = storedDevice(localStorage.getItem(DEVICE_KEY));
    if (legacy !== undefined && legacy.hostKey === hostKey) localStorage.removeItem(DEVICE_KEY);
    return Promise.resolve();
  },
  setName: (hostKey, name) => {
    const hosts = migrated();
    if (!hosts.some((each) => each.hostKey === hostKey)) return Promise.resolve();
    writeHosts(hosts.map((each) => (each.hostKey === hostKey ? { ...each, name } : each)));
    return Promise.resolve();
  },
  updateEndpoints: (hostKey, endpointSet) => {
    const hosts = migrated();
    const index = hosts.findIndex((each) => each.hostKey === hostKey);
    if (index === -1) return Promise.resolve();
    const next = [...hosts];
    next[index] = updateStoredHostEndpoints(hosts[index]!, endpointSet);
    writeHosts(next);
    return Promise.resolve();
  },
  updateConnection: (hostKey, change) => {
    const hosts = migrated();
    const index = hosts.findIndex((each) => each.hostKey === hostKey);
    if (index === -1) return Promise.resolve();
    const next = [...hosts];
    next[index] = updateStoredHostConnection(hosts[index]!, change);
    writeHosts(next);
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
    list: async () => {
      const unsaved = await (migration ??= migrate());
      const hosts = await bridge.hosts.list();
      return unsaved === undefined || hosts.some((entry) => entry.hostKey === unsaved.hostKey)
        ? hosts
        : [...hosts, unsaved];
    },
    save: (host) => bridge.hosts.save(host),
    remove: (hostKey) => bridge.hosts.remove(hostKey),
    setName: (hostKey, name) => bridge.hosts.setName(hostKey, name),
    updateEndpoints: (hostKey, endpointSet) => bridge.hosts.updateEndpoints(hostKey, endpointSet),
    updateConnection: (hostKey, change) => bridge.hosts.updateConnection(hostKey, change),
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
  /** The one focused host/conversation for the whole app (ADR-0035 §1). */
  readonly focus: HostFocus | null;
  /** Persist a new pairing and add its runtime; it never moves focus. */
  readonly paired: (host: StoredHost) => Promise<void>;
  /** Persist an announced host name and update the in-memory list. */
  readonly setName: (hostKey: string, name: string) => Promise<void>;
  /** Persist a host-published remote set and update the in-memory list in place. */
  readonly endpoints: (hostKey: string, endpointSet: EndpointSet) => Promise<void>;
  /** Persist a connection preference or RTC hint and update the in-memory list in place. */
  readonly setConnection: (hostKey: string, change: StoredHostConnectionChange) => Promise<void>;
  /** Focus a host, restoring the conversation it last showed when known. */
  readonly focusHost: (hostKey: string) => void;
  /** Focus one conversation, releasing every other host's conversation stream. */
  readonly focusConversation: (ref: ConversationRef) => void;
  /** Focus a host's draft, clearing its remembered conversation. */
  readonly focusDraft: (hostKey: string) => void;
  /** Close and remove one host runtime, without reloading the page. */
  readonly forget: (hostKey: string) => Promise<void>;
  /**
   * Close and remove one host runtime without declining it — for a superseded
   * identity (a key-change re-pair), not a user forget.
   */
  readonly dropHost: (hostKey: string) => Promise<void>;
};

const defaultState: HostsState = {
  store: browserStore,
  hosts: [],
  focus: null,
  paired: (host) => browserStore.save(host),
  setName: (hostKey, name) => browserStore.setName(hostKey, name),
  endpoints: (hostKey, endpointSet) => browserStore.updateEndpoints(hostKey, endpointSet),
  setConnection: (hostKey, change) => browserStore.updateConnection(hostKey, change),
  focusHost: () => {},
  focusConversation: () => {},
  focusDraft: () => {},
  forget: (hostKey) => browserStore.remove(hostKey),
  dropHost: (hostKey) => browserStore.remove(hostKey),
};

// Deep components — the sidebar footer, the connection-failure screens — read
// this instead of threading the host list through every layer.
export const HostsContext = createContext<HostsState>(defaultState);
export const useHosts = (): HostsState => useContext(HostsContext);

/**
 * Cache the machine name a 5.12 host announces on its settings stream onto
 * this connection's stored entry — keyed by the connection's hostKey, never
 * by the focused host. A missing `hostName` (older host, pre-snapshot view)
 * is a skip, not a clear: a cached name survives it.
 */
export function useHostNameSync(hostKey: string | undefined, settings: HostSettings | null): void {
  const { hosts, setName } = useHosts();
  const announced = settings?.hostName;
  useEffect(() => {
    if (hostKey === undefined || announced === undefined) return;
    const entry = hosts.find((each) => each.hostKey === hostKey);
    if (entry === undefined || entry.name === announced) return;
    void setName(hostKey, announced).catch((error: unknown) =>
      console.error("Could not store the host name", error),
    );
  }, [hostKey, announced, hosts, setName]);
}
