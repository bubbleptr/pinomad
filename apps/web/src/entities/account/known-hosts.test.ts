import { beforeEach, describe, expect, it } from "vitest";
import { KNOWN_HOSTS_KEY, createKnownHostsStore } from "./known-hosts.ts";

beforeEach(() => localStorage.clear());

const kieran = { serverOrigin: "https://pinomad.si", user: "kieran" };

describe("known account hosts", () => {
  it("seeds silently the first time it sees an account's hosts", () => {
    const store = createKnownHostsStore(localStorage);
    expect(store.arrivals(kieran, ["h1", "h2"])).toEqual([]);
  });

  it("reports a host that appears later once, then never again", () => {
    const store = createKnownHostsStore(localStorage);
    store.arrivals(kieran, ["h1"]);
    expect(store.arrivals(kieran, ["h1", "h2"])).toEqual(["h2"]);
    expect(store.arrivals(kieran, ["h1", "h2"])).toEqual([]);
    // Survives a reload: a fresh store reads the same set.
    expect(createKnownHostsStore(localStorage).arrivals(kieran, ["h1", "h2"])).toEqual([]);
  });

  it("seeds an empty account too, so its first host is announced", () => {
    const store = createKnownHostsStore(localStorage);
    expect(store.arrivals(kieran, [])).toEqual([]);
    expect(store.arrivals(kieran, ["h1"])).toEqual(["h1"]);
  });

  it("keeps one set per account and server", () => {
    const store = createKnownHostsStore(localStorage);
    store.arrivals(kieran, ["h1"]);
    expect(store.arrivals({ serverOrigin: "https://pinomad.si/", user: "kieran" }, ["h1", "h2"])).toEqual(["h2"]);
    expect(store.arrivals({ serverOrigin: "https://pinomad.si", user: "alex" }, ["h3"])).toEqual([]);
    expect(store.arrivals({ serverOrigin: "https://nomad.example.com", user: "kieran" }, ["h4"])).toEqual([]);
  });

  it("skips the notice for a host this device confirmed itself", () => {
    const store = createKnownHostsStore(localStorage);
    store.arrivals(kieran, ["h1"]);
    store.add(kieran, "h2");
    expect(store.arrivals(kieran, ["h1", "h2"])).toEqual([]);
  });

  it("doesn't start a set from a confirm, which would announce every other host", () => {
    const store = createKnownHostsStore(localStorage);
    store.add(kieran, "h2");
    expect(store.arrivals(kieran, ["h1", "h2"])).toEqual([]);
  });

  it("treats a garbled entry as no set rather than crashing", () => {
    localStorage.setItem(KNOWN_HOSTS_KEY, "not json");
    expect(createKnownHostsStore(localStorage).arrivals(kieran, ["h1"])).toEqual([]);
    localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify({ "https://pinomad.si\u0000kieran": [1, "h1"] }));
    expect(createKnownHostsStore(localStorage).arrivals(kieran, ["h1", "h2"])).toEqual(["h2"]);
  });

  it("announces nothing when storage throws", () => {
    const broken: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createKnownHostsStore(broken);
    expect(store.arrivals(kieran, ["h1"])).toEqual([]);
    expect(store.arrivals(kieran, ["h1", "h2"])).toEqual([]);
    expect(() => store.add(kieran, "h3")).not.toThrow();
  });
});
