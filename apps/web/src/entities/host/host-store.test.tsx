// jsdom project: the browser store wraps localStorage; the desktop store wraps
// a stand-in for the preload bridge.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { HostSettings } from "@pinomad/protocol/settings.ts";
import { DEVICE_KEY } from "../../address.ts";
import { HOSTS_KEY, HostsContext, hostStore, useHostNameSync, type HostsState, type StoredHost } from "./host-store.ts";
import type { DesktopBridge } from "./desktop-bridge.ts";

const host = (url = "ws://127.0.0.1:7420/secure"): StoredHost => ({
  url,
  hostKey: toBase64Url(generateKeyPair().publicKey),
  privateKey: toBase64Url(generateKeyPair().privateKey),
});

/** An in-memory stand-in for the Electron preload bridge. */
const fakeBridge = ({ failSaves = false }: { failSaves?: boolean } = {}): DesktopBridge & { saved: StoredHost[] } => {
  const saved: StoredHost[] = [];
  return {
    saved,
    hosts: {
      list: () => Promise.resolve([...saved]),
      save: (entry) => {
        if (failSaves) return Promise.reject(new Error("save failed"));
        const index = saved.findIndex((each) => each.hostKey === entry.hostKey);
        if (index === -1) saved.push(entry);
        else saved[index] = entry;
        return Promise.resolve();
      },
      remove: (hostKey) => {
        const index = saved.findIndex((each) => each.hostKey === hostKey);
        if (index !== -1) saved.splice(index, 1);
        return Promise.resolve();
      },
      setName: (hostKey, name) => {
        const index = saved.findIndex((each) => each.hostKey === hostKey);
        if (index !== -1) saved[index] = { ...saved[index]!, name };
        return Promise.resolve();
      },
    },
  };
};

beforeEach(() => {
  localStorage.clear();
  delete window.pinomadDesktop;
});

describe("browser host store", () => {
  it("keeps every paired host: save upserts by hostKey, remove drops the match", async () => {
    const store = hostStore();
    expect(await store.list()).toEqual([]);

    const a = host();
    const b = host("ws://10.0.0.9:7420/secure");
    await store.save(a);
    await store.save(b);
    expect(await store.list()).toEqual([a, b]);

    // Re-pairing the same host refreshes the entry in place, not a duplicate.
    const again = { ...a, url: "wss://relay.example.com/c/x" };
    await store.save(again);
    expect(await store.list()).toEqual([b, again]);

    await store.remove(b.hostKey);
    expect(await store.list()).toEqual([again]);
    await store.remove(again.hostKey);
    expect(await store.list()).toEqual([]);
  });

  it("migrates the legacy single-device record into the list", async () => {
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(await store.list()).toEqual([legacy]);
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(HOSTS_KEY)!)).toEqual([legacy]);
  });

  it("does not resurrect a migrated host that was removed", async () => {
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    await store.list();
    await store.remove(legacy.hostKey);
    expect(await hostStore().list()).toEqual([]);
  });

  it("setName renames the entry in place and touches nothing else", async () => {
    const store = hostStore();
    const a = host();
    const b = host("ws://10.0.0.9:7420/secure");
    await store.save(a);
    await store.save(b);

    await store.setName(a.hostKey, "Desk");
    expect(await store.list()).toEqual([{ ...a, name: "Desk" }, b]);
    // Order and the other entry are untouched; renaming again overwrites.
    await store.setName(b.hostKey, "Bench");
    expect(await store.list()).toEqual([{ ...a, name: "Desk" }, { ...b, name: "Bench" }]);
  });

  it("setName writes nothing for an entry that is not there", async () => {
    const store = hostStore();
    const a = host();
    await store.save(a);
    await store.remove(a.hostKey);
    // A name arriving after the entry was removed must not resurrect it.
    await store.setName(a.hostKey, "Desk");
    expect(await store.list()).toEqual([]);
    await store.setName("never-paired", "Desk");
    expect(await store.list()).toEqual([]);
  });

  it("ignores malformed localStorage content", async () => {
    localStorage.setItem(HOSTS_KEY, "not json");
    expect(await hostStore().list()).toEqual([]);
    localStorage.setItem(HOSTS_KEY, JSON.stringify([{ url: "ws://x", hostKey: "short", privateKey: "short" }, host()]));
    expect((await hostStore().list()).length).toBe(1);
    localStorage.setItem(DEVICE_KEY, "not json");
    expect((await hostStore().list()).length).toBe(1);
  });
});

describe("desktop host store", () => {
  it("migrates a legacy localStorage device into the bridge", async () => {
    const bridge = fakeBridge();
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(await store.list()).toEqual([legacy]);
    expect(bridge.saved).toEqual([legacy]);
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it("merges a legacy device into a bridge that already holds other hosts", async () => {
    const bridge = fakeBridge();
    const existing = host("ws://10.0.0.9:7420/secure");
    bridge.saved.push(existing);
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(await store.list()).toEqual([existing, legacy]);
    expect(bridge.saved).toEqual([existing, legacy]);
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it("keeps the bridge's copy of a host the legacy device also names", async () => {
    const bridge = fakeBridge();
    const newer = host();
    bridge.saved.push(newer);
    window.pinomadDesktop = bridge;
    // Same hostKey, an older privateKey — the encrypted list's entry wins.
    const legacy = { url: "ws://127.0.0.1:7420/secure", hostKey: newer.hostKey, privateKey: toBase64Url(generateKeyPair().privateKey) };
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(await store.list()).toEqual([newer]);
    expect(bridge.saved).toEqual([newer]);
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it("runs the migration once even for concurrent list calls", async () => {
    const bridge = fakeBridge();
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    const [first, second] = await Promise.all([store.list(), store.list()]);
    expect(first).toEqual([legacy]);
    expect(second).toEqual([legacy]);
  });

  it("serves an unsaveable legacy device for the session and keeps it for next launch", async () => {
    const bridge = fakeBridge({ failSaves: true });
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(await store.list()).toEqual([legacy]);
    expect(bridge.saved).toEqual([]);
    expect(localStorage.getItem(DEVICE_KEY)).toBe(JSON.stringify(legacy));
  });

  it("does not resurrect a migrated host that was removed", async () => {
    const bridge = fakeBridge();
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    await store.list();
    await store.remove(legacy.hostKey);
    expect(await hostStore().list()).toEqual([]);
  });

  it("setName goes through the bridge without touching other fields", async () => {
    const bridge = fakeBridge();
    window.pinomadDesktop = bridge;
    const a = host();
    bridge.saved.push(a);

    const store = hostStore();
    await store.setName(a.hostKey, "Desk");
    expect(bridge.saved).toEqual([{ ...a, name: "Desk" }]);
    expect(await store.list()).toEqual([{ ...a, name: "Desk" }]);
  });
});

describe("useHostNameSync", () => {
  const settingsWith = (hostName: string | null | undefined): HostSettings | null =>
    hostName === null ? null : ({ hostName } as HostSettings);

  function Probe({ hostKey, settings }: { hostKey?: string; settings: HostSettings | null }) {
    useHostNameSync(hostKey, settings);
    return null;
  }

  const renderSync = (state: HostsState, hostKey: string | undefined, settings: HostSettings | null) =>
    render(
      <HostsContext.Provider value={state}>
        <Probe hostKey={hostKey} settings={settings} />
      </HostsContext.Provider>,
    );

  const fakeState = (hosts: readonly StoredHost[]) => {
    const setName = vi.fn((_hostKey: string, _name: string) => Promise.resolve());
    const state: HostsState = {
      store: hostStore(),
      hosts,
      activeHostKey: null,
      paired: () => Promise.resolve(),
      setName,
    };
    return { state, setName };
  };

  it("writes the announced host name onto the paired entry once", async () => {
    const entry = host();
    const { state, setName } = fakeState([entry]);
    const { rerender } = renderSync(state, entry.hostKey, settingsWith("Desk"));
    await vi.waitFor(() => expect(setName).toHaveBeenCalledWith(entry.hostKey, "Desk"));
    // A re-render of the same announced name does not write again.
    rerender(
      <HostsContext.Provider value={state}>
        <Probe hostKey={entry.hostKey} settings={settingsWith("Desk")} />
      </HostsContext.Provider>,
    );
    await act(async () => {});
    expect(setName).toHaveBeenCalledTimes(1);
  });

  it("keeps the cache when the settings stream has no hostName or is absent", async () => {
    const entry = host();
    const { state, setName } = fakeState([entry]);
    renderSync(state, entry.hostKey, settingsWith(undefined));
    await act(async () => {});
    renderSync(state, entry.hostKey, settingsWith(null));
    await act(async () => {});
    expect(setName).not.toHaveBeenCalled();
  });

  it("writes nothing when the entry is absent or the name already matches", async () => {
    const entry = { ...host(), name: "Desk" };
    const { state, setName } = fakeState([entry]);
    renderSync(state, entry.hostKey, settingsWith("Desk"));
    // The announced key names a different host than the stored one.
    renderSync(state, "other-key", settingsWith("Bench"));
    await act(async () => {});
    expect(setName).not.toHaveBeenCalled();
  });
});
