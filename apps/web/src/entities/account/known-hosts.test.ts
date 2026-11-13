import { beforeEach, describe, expect, it } from "vitest";
import { KNOWN_HOSTS_KEY, createKnownHostsStore } from "./known-hosts.ts";

beforeEach(() => localStorage.clear());

const kieran = { serverOrigin: "https://pinomad.si", user: "kieran" };
/** Rows from a server without join times (before #531). */
const ids = (...hostIds: string[]) => hostIds.map((hostId) => ({ hostId }));

describe("known account hosts", () => {
  it("seeds silently the first time it sees an account's hosts", () => {
    const store = createKnownHostsStore(localStorage);
    expect(store.arrivals(kieran, ids("h1", "h2"))).toEqual([]);
  });

  it("reports a host that appears later once, then never again", () => {
    const store = createKnownHostsStore(localStorage);
    store.arrivals(kieran, ids("h1"));
    expect(store.arrivals(kieran, ids("h1", "h2"))).toEqual(["h2"]);
    expect(store.arrivals(kieran, ids("h1", "h2"))).toEqual([]);
    // Survives a reload: a fresh store reads the same set.
    expect(createKnownHostsStore(localStorage).arrivals(kieran, ids("h1", "h2"))).toEqual([]);
  });

  it("seeds an empty account too, so its first host is announced", () => {
    const store = createKnownHostsStore(localStorage);
    expect(store.arrivals(kieran, ids())).toEqual([]);
    expect(store.arrivals(kieran, ids("h1"))).toEqual(["h1"]);
  });

  it("keeps one set per account and server", () => {
    const store = createKnownHostsStore(localStorage);
    store.arrivals(kieran, ids("h1"));
    expect(store.arrivals({ serverOrigin: "https://pinomad.si/", user: "kieran" }, ids("h1", "h2"))).toEqual(["h2"]);
    expect(store.arrivals({ serverOrigin: "https://pinomad.si", user: "alex" }, ids("h3"))).toEqual([]);
    expect(store.arrivals({ serverOrigin: "https://nomad.example.com", user: "kieran" }, ids("h4"))).toEqual([]);
  });

  it("skips the notice for a host this device confirmed itself", () => {
    const store = createKnownHostsStore(localStorage);
    store.arrivals(kieran, ids("h1"));
    store.add(kieran, "h2");
    expect(store.arrivals(kieran, ids("h1", "h2"))).toEqual([]);
  });

  it("doesn't start a set from a confirm, which would announce every other host", () => {
    const store = createKnownHostsStore(localStorage);
    store.add(kieran, "h2");
    expect(store.arrivals(kieran, ids("h1", "h2"))).toEqual([]);
  });

  it("treats a garbled entry as no set rather than crashing", () => {
    localStorage.setItem(KNOWN_HOSTS_KEY, "not json");
    expect(createKnownHostsStore(localStorage).arrivals(kieran, ids("h1"))).toEqual([]);
    localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify({ "https://pinomad.si\u0000kieran": [1, "h1"] }));
    expect(createKnownHostsStore(localStorage).arrivals(kieran, ids("h1", "h2"))).toEqual(["h2"]);
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
    expect(store.arrivals(kieran, ids("h1"))).toEqual([]);
    expect(store.arrivals(kieran, ids("h1", "h2"))).toEqual([]);
    expect(() => store.add(kieran, "h3")).not.toThrow();
  });

  describe("join times (#531)", () => {
    const at = (hostId: string, joinedAt: number) => ({ hostId, joinedAt });

    it("announces a host again when it joins again, after a removal", () => {
      const store = createKnownHostsStore(localStorage);
      store.arrivals(kieran, []);
      expect(store.arrivals(kieran, [at("h1", 1)])).toEqual(["h1"]);
      expect(store.arrivals(kieran, [at("h1", 1)])).toEqual([]);
      expect(store.arrivals(kieran, [at("h1", 2)])).toEqual(["h1"]);
      expect(store.arrivals(kieran, [at("h1", 2)])).toEqual([]);
    });

    it("counts a host known before join times as announced for the join it has now", () => {
      localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify({ "https://pinomad.si\u0000kieran": ["h1"] }));
      const store = createKnownHostsStore(localStorage);
      expect(store.arrivals(kieran, [at("h1", 5)])).toEqual([]);
      expect(store.arrivals(kieran, [at("h1", 5)])).toEqual([]);
      expect(store.arrivals(kieran, [at("h1", 6)])).toEqual(["h1"]);
    });

    it("skips the notice when this device confirmed the host's new join itself", () => {
      const store = createKnownHostsStore(localStorage);
      store.arrivals(kieran, [at("h1", 1)]);
      store.add(kieran, "h1");
      expect(store.arrivals(kieran, [at("h1", 2)])).toEqual([]);
      // That confirm covered one join, not the next.
      expect(store.arrivals(kieran, [at("h1", 3)])).toEqual(["h1"]);
    });

    it("doesn't let a confirm of a host already listed hide its next join", () => {
      const store = createKnownHostsStore(localStorage);
      store.arrivals(kieran, [at("h1", 1)]);
      store.add(kieran, "h1");
      expect(store.arrivals(kieran, [at("h1", 1)])).toEqual([]);
      expect(store.arrivals(kieran, [at("h1", 2)])).toEqual(["h1"]);
    });

    it("stays quiet when the server stops sending join times", () => {
      const store = createKnownHostsStore(localStorage);
      store.arrivals(kieran, [at("h1", 1)]);
      expect(store.arrivals(kieran, ids("h1"))).toEqual([]);
    });
  });
});
