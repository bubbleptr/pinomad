import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECLINED_KEY, createDeclinedStore, readDeclined } from "./declined.ts";

beforeEach(() => localStorage.clear());

describe("declined account hosts", () => {
  it("persists normalized origins and deduplicates identities", () => {
    const store = createDeclinedStore(localStorage);
    store.add({ serverOrigin: "https://relay.example.com/", hostId: "h1" });
    store.add({ serverOrigin: "https://relay.example.com", hostId: "h1" });
    expect(store.list()).toEqual([{ serverOrigin: "https://relay.example.com", hostId: "h1" }]);
    expect(readDeclined(localStorage)).toHaveLength(1);
  });

  it("removes only the matching identity and notifies listeners", () => {
    const store = createDeclinedStore(localStorage);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.add({ serverOrigin: "https://a.example.com", hostId: "h1" });
    store.add({ serverOrigin: "https://a.example.com", hostId: "h2" });
    store.remove({ serverOrigin: "https://a.example.com/", hostId: "h1" });
    expect(store.list()).toEqual([{ serverOrigin: "https://a.example.com", hostId: "h2" }]);
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    store.add({ serverOrigin: "https://a.example.com", hostId: "h3" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("drops malformed entries instead of crashing", () => {
    localStorage.setItem(DECLINED_KEY, JSON.stringify([null, { hostId: 3 }, { serverOrigin: "https://x", hostId: "ok" }]));
    expect(readDeclined(localStorage)).toEqual([{ serverOrigin: "https://x", hostId: "ok" }]);
    localStorage.setItem(DECLINED_KEY, "not json");
    expect(readDeclined(localStorage)).toEqual([]);
  });
});
