// jsdom project: the browser store wraps localStorage; the desktop store wraps
// a stand-in for the preload bridge.
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { DEVICE_KEY } from "../../address.ts";
import { hostStore, type StoredHost } from "./host-store.ts";
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
    },
  };
};

beforeEach(() => {
  localStorage.clear();
  delete window.pinomadDesktop;
});

describe("browser host store", () => {
  it("keeps a single device: save replaces, remove only clears a match", async () => {
    const store = hostStore();
    expect(store.multiHost).toBe(false);
    expect(await store.list()).toEqual([]);

    const a = host();
    const b = host("ws://10.0.0.9:7420/secure");
    await store.save(a);
    await store.save(b);
    expect(await store.list()).toEqual([b]);

    await store.remove(a.hostKey);
    expect(await store.list()).toEqual([b]);
    await store.remove(b.hostKey);
    expect(await store.list()).toEqual([]);
  });

  it("ignores malformed localStorage content", async () => {
    localStorage.setItem(DEVICE_KEY, "not json");
    expect(await hostStore().list()).toEqual([]);
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ url: "ws://x", hostKey: "short", privateKey: "short" }));
    expect(await hostStore().list()).toEqual([]);
  });
});

describe("desktop host store", () => {
  it("marks multiHost and migrates a legacy localStorage device into the bridge", async () => {
    const bridge = fakeBridge();
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(store.multiHost).toBe(true);
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
});
