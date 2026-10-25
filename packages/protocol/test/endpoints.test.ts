import { describe, expect, it } from "vitest";
import {
  ENDPOINT_SET_SCHEMA_VERSION,
  MAX_HOST_ENDPOINTS,
  MAX_HOST_ENDPOINT_URL_LENGTH,
  encodeEndpointSetParam,
  parseEndpointSet,
  parseEndpointSetParam,
  type EndpointSet,
  type HostEndpoint,
} from "../src/endpoints.ts";

const relay: HostEndpoint = { transport: "webSocket", role: "relay", url: "wss://relay.example.com/c/host" };
const direct: HostEndpoint = { transport: "webSocket", role: "direct", url: "ws://192.168.1.5:7422/secure" };
const set = (...endpoints: HostEndpoint[]): EndpointSet => ({ schemaVersion: 1, endpoints });

describe("parseEndpointSet", () => {
  it("accepts supported endpoints in publication order", () => {
    expect(parseEndpointSet(set(relay, direct))).toEqual({
      kind: "valid",
      endpointSet: { schemaVersion: ENDPOINT_SET_SCHEMA_VERSION, endpoints: [relay, direct] },
    });
  });

  it("accepts an explicit empty set", () => {
    expect(parseEndpointSet(set())).toEqual({ kind: "valid", endpointSet: set() });
  });

  it("treats a missing field as absent", () => {
    expect(parseEndpointSet(undefined)).toEqual({ kind: "absent" });
  });

  it("dedupes identical entries, keeping the first occurrence", () => {
    expect(parseEndpointSet(set(relay, relay))).toEqual({ kind: "valid", endpointSet: set(relay) });
  });

  it("rejects the same transport + URL with conflicting roles", () => {
    const conflicting = { ...direct, role: "relay" } as HostEndpoint;
    expect(parseEndpointSet(set(direct, conflicting))).toEqual({ kind: "malformed" });
  });

  it("keeps lone surrogates in URL identity instead of collapsing them", () => {
    const first = { ...relay, url: "ws://example.com/\uD800" };
    const second = { ...relay, url: "ws://example.com/\uD801" };
    expect(parseEndpointSet(set(first, second))).toEqual({ kind: "valid", endpointSet: set(first, second) });
    expect(parseEndpointSet(set(first, first))).toEqual({ kind: "valid", endpointSet: set(first) });
    expect(parseEndpointSet(set(first, { ...first, role: "direct" }))).toEqual({ kind: "malformed" });
  });

  it("ignores unknown transports, but only when a supported entry remains", () => {
    const future = { transport: "quic", role: "relay", url: "quic://relay.example.com" } as unknown as HostEndpoint;
    expect(parseEndpointSet(set(future, relay))).toEqual({ kind: "valid", endpointSet: set(relay) });
    expect(parseEndpointSet(set(future))).toEqual({ kind: "unsupported" });
  });

  it("ignores an unknown schema without validating the rest", () => {
    expect(parseEndpointSet({ schemaVersion: 2, endpoints: "not an array" })).toEqual({ kind: "unsupported" });
  });

  it.each([null, "set", [], { endpoints: [] }, { schemaVersion: "1", endpoints: [] }])(
    "rejects malformed shapes: %s",
    (value) => {
      expect(parseEndpointSet(value)).toEqual({ kind: "malformed" });
    },
  );

  it("rejects a known schema whose endpoints are not an array", () => {
    expect(parseEndpointSet({ schemaVersion: 1, endpoints: null })).toEqual({ kind: "malformed" });
  });

  it("rejects malformed entries, roles and URLs", () => {
    expect(parseEndpointSet(set(null as unknown as HostEndpoint))).toEqual({ kind: "malformed" });
    expect(parseEndpointSet(set({ ...relay, role: "backup" } as unknown as HostEndpoint))).toEqual({ kind: "malformed" });
    expect(parseEndpointSet(set({ ...relay, url: 42 } as unknown as HostEndpoint))).toEqual({ kind: "malformed" });
    expect(parseEndpointSet(set({ ...relay, url: "http://relay.example.com" }))).toEqual({ kind: "malformed" });
    expect(parseEndpointSet(set({ ...relay, url: "not a url" }))).toEqual({ kind: "malformed" });
  });

  it("caps the raw list before filtering unknown transports", () => {
    const unknown = { transport: "quic", role: "direct", url: "quic://x" } as unknown as HostEndpoint;
    expect(parseEndpointSet(set(unknown, unknown, unknown, unknown, relay))).toEqual({ kind: "malformed" });
  });

  it("measures the URL limit in UTF-16 code units", () => {
    const prefix = "ws://e/";
    const atLimit = prefix + "a" + "😀".repeat((MAX_HOST_ENDPOINT_URL_LENGTH - prefix.length - 1) / 2);
    const overLimit = atLimit + "a";
    expect(atLimit.length).toBe(MAX_HOST_ENDPOINT_URL_LENGTH);
    expect(overLimit.length).toBe(MAX_HOST_ENDPOINT_URL_LENGTH + 1);
    expect(parseEndpointSet(set({ ...direct, url: atLimit }))).toEqual({
      kind: "valid",
      endpointSet: set({ ...direct, url: atLimit }),
    });
    expect(parseEndpointSet(set({ ...direct, url: overLimit }))).toEqual({ kind: "malformed" });
  });

  it("keeps the raw list cap", () => {
    expect(MAX_HOST_ENDPOINTS).toBe(4);
    expect(parseEndpointSet(set(relay, relay, relay, relay))).toEqual({ kind: "valid", endpointSet: set(relay) });
    expect(parseEndpointSet(set(relay, relay, relay, relay, relay))).toEqual({ kind: "malformed" });
  });
});

describe("endpointSet query parameter", () => {
  it("round-trips through the compact link encoding", () => {
    const encoded = encodeEndpointSetParam(set(relay, direct));
    expect(decodeURIComponent(encoded)).toBe(JSON.stringify(set(relay, direct)));
    expect(parseEndpointSetParam(decodeURIComponent(encoded))).toEqual({ kind: "valid", endpointSet: set(relay, direct) });
  });

  it("rejects text that is not the shared JSON shape", () => {
    expect(parseEndpointSetParam("{")).toEqual({ kind: "malformed" });
    expect(parseEndpointSetParam("[]")).toEqual({ kind: "malformed" });
  });
});
