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
const fakeBridge = (): DesktopBridge & { saved: StoredHost[] } => {
  const saved: StoredHost[] = [];
  return {
    saved,
    hosts: {
      list: () => Promise.resolve([...saved]),
      save: (entry) => {
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
  it("migrates a legacy localStorage device into the bridge once", async () => {
    const bridge = fakeBridge();
    window.pinomadDesktop = bridge;
    const legacy = host();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy));

    const store = hostStore();
    expect(await store.list()).toEqual([legacy]);
    expect(bridge.saved).toEqual([legacy]);
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it("does not migrate when the bridge already holds hosts", async () => {
    const bridge = fakeBridge();
    const existing = host();
    bridge.saved.push(existing);
    window.pinomadDesktop = bridge;
    localStorage.setItem(DEVICE_KEY, JSON.stringify(host()));

    const store = hostStore();
    expect(await store.list()).toEqual([existing]);
    // The stale browser key stays put rather than silently dropping it — the
    // desktop path never reads it again either way.
    expect(bridge.saved).toEqual([existing]);
  });
});
