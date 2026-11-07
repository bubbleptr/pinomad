// The routes Settings → Hosts lists under each machine (#502): which network
// each published endpoint is on, which ones the connection mode leaves out,
// which ones this page cannot open, and which one carries the connection now.
import { describe, expect, it } from "vitest";
import type { EndpointSet, HostEndpoint } from "@pinomad/protocol/endpoints.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { hostRoutes } from "./host-routes.ts";

const KEY = "A".repeat(43);
const endpoint = (role: HostEndpoint["role"], url: string): HostEndpoint => ({ transport: "webSocket", role, url });
const set = (...endpoints: HostEndpoint[]): EndpointSet => ({ schemaVersion: 1, endpoints });
const host = (overrides: Partial<StoredHost>): StoredHost => ({
  url: "wss://app.pinomad.si/relay/h",
  hostKey: KEY,
  privateKey: KEY,
  ...overrides,
});

const RELAY = endpoint("relay", "wss://app.pinomad.si/relay/h");
const TAILNET = endpoint("direct", "wss://studio.tailf76614.ts.net:7422");
const LAN = endpoint("direct", "ws://192.168.1.42:7422");

describe("hostRoutes", () => {
  it("names each route by the network it runs over, relay first", () => {
    const routes = hostRoutes(host({ endpointSet: set(TAILNET, LAN, RELAY) }));
    expect(routes.map(({ label, address }) => [label, address])).toEqual([
      ["Relay", "app.pinomad.si"],
      ["Tailnet", "studio.tailf76614.ts.net:7422"],
      ["LAN", "192.168.1.42:7422"],
    ]);
  });

  it("calls the relay of the account the host joined the account relay", () => {
    const routes = hostRoutes(
      host({ endpointSet: set(RELAY), account: { serverOrigin: "https://app.pinomad.si", hostId: KEY } }),
    );
    expect(routes[0]?.label).toBe("Account relay");
  });

  it("puts this computer's own address first", () => {
    const routes = hostRoutes(host({ url: "ws://127.0.0.1:7431", endpointSet: set(RELAY) }));
    expect(routes.map((route) => route.label)).toEqual(["Local", "Relay"]);
  });

  it("falls back to the paired address when the host published no set", () => {
    const routes = hostRoutes(host({ url: "wss://100.101.102.103:7422" }));
    expect(routes).toEqual([
      expect.objectContaining({ label: "Tailnet", address: "100.101.102.103:7422", state: "available" }),
    ]);
  });

  it("marks the routes the connection mode leaves out", () => {
    const relayOnly = hostRoutes(host({ endpointSet: set(RELAY, TAILNET), connectionMode: "relayOnly" }));
    expect(relayOnly.map((route) => route.state)).toEqual(["available", "off"]);
    const directOnly = hostRoutes(host({ endpointSet: set(RELAY, TAILNET), connectionMode: "directOnly" }));
    expect(directOnly.map((route) => route.state)).toEqual(["off", "available"]);
  });

  it("marks an insecure remote address an HTTPS page cannot open as blocked", () => {
    const routes = hostRoutes(host({ endpointSet: set(RELAY, LAN) }), { pageProtocol: "https:" });
    expect(routes.map((route) => route.state)).toEqual(["available", "blocked"]);
  });

  it("marks the route in use when the live path names exactly one", () => {
    const routes = hostRoutes(host({ endpointSet: set(RELAY, TAILNET) }), { path: "relay" });
    expect(routes.map((route) => route.inUse === true)).toEqual([true, false]);
  });

  it("marks a pre-endpoint-set host's only address in use, which the coordinator reports as relay", () => {
    const routes = hostRoutes(host({ url: "wss://studio.tailf76614.ts.net:7422" }), { path: "relay" });
    expect(routes[0]?.inUse).toBe(true);
  });

  it("marks nothing in use when several routes share the live path", () => {
    const routes = hostRoutes(host({ endpointSet: set(TAILNET, LAN) }), { path: "direct" });
    expect(routes.some((route) => route.inUse === true)).toBe(false);
  });

  it("marks nothing in use over P2P, which is not one of these sockets", () => {
    const routes = hostRoutes(host({ endpointSet: set(RELAY) }), { path: "p2p" });
    expect(routes[0]?.inUse).toBeUndefined();
  });
});
