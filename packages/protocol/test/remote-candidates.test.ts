import { describe, expect, it } from "vitest";
import {
  candidatePlan,
  preferredLegacyUrl,
  type RemoteCandidate,
} from "../src/remote-candidates.ts";
import type { EndpointSet, HostEndpoint } from "../src/endpoints.ts";

const endpointSet = (...endpoints: HostEndpoint[]): EndpointSet => ({ schemaVersion: 1, endpoints });
const relay = (url: string): HostEndpoint => ({ transport: "webSocket", role: "relay", url });
const direct = (url: string): HostEndpoint => ({ transport: "webSocket", role: "direct", url });

const urls = (candidates: readonly RemoteCandidate[]): string[] => candidates.map((candidate) => candidate.url);

describe("candidatePlan", () => {
  it("puts a client-local loopback first, then relays, then directs", () => {
    const plan = candidatePlan(
      "ws://127.0.0.1:7420/secure",
      endpointSet(direct("wss://direct.example/"), relay("wss://relay-b.example/"), relay("wss://relay-a.example/")),
    );
    expect(plan.map((candidate) => [candidate.role, candidate.url])).toEqual([
      ["loopback", "ws://127.0.0.1:7420/secure"],
      ["relay", "wss://relay-b.example/"],
      ["relay", "wss://relay-a.example/"],
      ["direct", "wss://direct.example/"],
    ]);
  });

  it("ignores a non-loopback legacy url when the host published a usable set", () => {
    const plan = candidatePlan("wss://old.example/", endpointSet(direct("wss://new.example/")));
    expect(urls(plan)).toEqual(["wss://new.example/"]);
  });

  it("falls back to the legacy url only when the set is absent", () => {
    expect(candidatePlan("wss://old.example/", undefined)).toEqual([
      { url: "wss://old.example/", role: "legacy" },
    ]);
  });

  it("keeps the local entry and drops remote candidates on an explicit empty set", () => {
    expect(candidatePlan("ws://localhost:7420/secure", endpointSet())).toEqual([
      { url: "ws://localhost:7420/secure", role: "loopback" },
    ]);
    expect(candidatePlan("wss://old.example/", endpointSet())).toEqual([]);
  });

  it("deduplicates by url, keeping the first role", () => {
    const plan = candidatePlan(
      "ws://127.0.0.1:7420/secure",
      endpointSet(relay("wss://relay.example/"), relay("wss://relay.example/"), direct("wss://relay.example/")),
    );
    expect(plan).toEqual([
      { url: "ws://127.0.0.1:7420/secure", role: "loopback" },
      { url: "wss://relay.example/", role: "relay" },
    ]);
  });

  it("marks remote insecure sockets unsupported on an HTTPS page, but never loopback", () => {
    const plan = candidatePlan(
      "ws://localhost:7420/secure",
      endpointSet(relay("ws://relay.example/"), direct("wss://direct.example/")),
      { pageProtocol: "https:" },
    );
    expect(plan[0]).toEqual({ url: "ws://localhost:7420/secure", role: "loopback" });
    expect(plan[1]).toMatchObject({ url: "ws://relay.example/", role: "relay" });
    expect(plan[1]?.unsupported).toContain("HTTPS");
    expect(plan[2]).toEqual({ url: "wss://direct.example/", role: "direct" });
  });
});

describe("preferredLegacyUrl", () => {
  it("uses the first relay, or the first direct when there is no relay", () => {
    expect(
      preferredLegacyUrl(
        "wss://old.example/",
        endpointSet(direct("wss://direct.example/"), relay("wss://relay.example/")),
      ),
    ).toBe("wss://relay.example/");
    expect(preferredLegacyUrl("wss://old.example/", endpointSet(direct("wss://direct.example/")))).toBe(
      "wss://direct.example/",
    );
  });

  it("never replaces a loopback legacy url and keeps the old url for an empty set", () => {
    expect(preferredLegacyUrl("ws://127.0.0.1:7420/secure", endpointSet(relay("wss://relay.example/")))).toBe(
      "ws://127.0.0.1:7420/secure",
    );
    expect(preferredLegacyUrl("wss://old.example/", endpointSet())).toBe("wss://old.example/");
  });
});
