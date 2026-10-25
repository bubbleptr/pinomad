import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { hostLabels, parseStoredHost } from "../src/stored-host.ts";
import { HOST_CASES, HOST_KEY_A, HOST_KEY_B, HOST_KEY_C, HOST_LABEL_CASES, KEY_A, KEY_B } from "./misc-cases.ts";

const key = () => toBase64Url(generateKeyPair().privateKey);
const valid = () => ({
  url: "ws://192.168.1.5:7422/secure",
  hostKey: key(),
  privateKey: key(),
});

const CASE = (name: string) => HOST_CASES.find((c) => c.name === name)!;

describe("parseStoredHost", () => {
  it("round-trips a valid entry", () => {
    const host = valid();
    expect(parseStoredHost({ ...host })).toEqual(host);
    expect(parseStoredHost({ ...host, url: "wss://relay.example.com/c/host" })).toEqual({
      ...host,
      url: "wss://relay.example.com/c/host",
    });
  });

  it("strips unknown extra fields", () => {
    const host = valid();
    expect(parseStoredHost({ ...host, unknownField: "x", nested: { x: 1 } })).toEqual(host);
  });

  it("keeps the stored name; a wrong shape or an empty one costs only the field", () => {
    const host = valid();
    expect(parseStoredHost({ ...host, name: "Workstation" })).toEqual({ ...host, name: "Workstation" });
    expect(parseStoredHost({ ...host, name: 42 })).toEqual(host);
    expect(parseStoredHost({ ...host, name: "" })).toEqual(host);
    expect(parseStoredHost({ ...host, name: { nested: true } })).toEqual(host);
  });

  it("round-trips the account link and tolerates its absence", () => {
    const host = valid();
    const account = { serverOrigin: "https://relay.example.com", hostId: host.hostKey };
    expect(parseStoredHost({ ...host, account })).toEqual({ ...host, account });
    expect(parseStoredHost(host)).toEqual(host);
  });

  it("drops a malformed account link but keeps the pairing", () => {
    const host = valid();
    for (const account of [{ hostId: host.hostKey }, { serverOrigin: "https://x", hostId: "short" }, "junk", 42]) {
      expect(parseStoredHost({ ...host, account })).toEqual(host);
    }
  });

  it.each(["http://localhost:5199/", "https://example.com", "not a url", 42])(
    "rejects a non-ws url %s",
    (url) => {
      expect(parseStoredHost({ ...valid(), url })).toBeUndefined();
    },
  );

  it("rejects a key that is not 32 bytes, or not base64url", () => {
    const host = valid();
    expect(parseStoredHost({ ...host, hostKey: toBase64Url(new Uint8Array(31)) })).toBeUndefined();
    expect(parseStoredHost({ ...host, privateKey: "not+base64url/===" })).toBeUndefined();
  });

  it.each([undefined, null, "ws://x", 42, ["a"]])("rejects non-object input %s", (value) => {
    expect(parseStoredHost(value)).toBeUndefined();
  });

  it("accepts the deterministic vector cases", () => {
    const parsed = parseStoredHost(CASE("valid").value);
    expect(parsed).toEqual({ url: "ws://192.168.1.5:7422/secure", hostKey: KEY_A, privateKey: KEY_B });
    const withAccount = parseStoredHost(CASE("account").value);
    expect(withAccount?.account).toEqual({ serverOrigin: "https://relay.example.com", hostId: HOST_KEY_A });
  });
});

describe("hostLabels", () => {
  it("labels each host by its URL host", () => {
    const labels = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "distinct")!.hosts);
    expect(labels.get(HOST_KEY_A)).toBe("10.0.0.2:7422");
    expect(labels.get(HOST_KEY_B)).toBe("10.0.0.3:7422");
  });

  it("disambiguates hosts sharing a host (two hosts on one relay)", () => {
    const labels = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "shared-relay")!.hosts);
    expect(labels.get(HOST_KEY_A)).toBe(`relay.example.com · ${HOST_KEY_A.slice(0, 6)}`);
    expect(labels.get(HOST_KEY_B)).toBe(`relay.example.com · ${HOST_KEY_B.slice(0, 6)}`);
    // A third host on its own URL keeps the plain label — and shares
    // HOST_KEY_A with relayA, so the Map keeps the last write.
    const labels3 = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "mixed")!.hosts);
    expect(labels3.get(HOST_KEY_A)).toBe("10.0.0.2:7422");
  });

  it("labels a stored host by its name when it has one (5.12)", () => {
    const labels = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "named")!.hosts);
    expect(labels.get(HOST_KEY_A)).toBe("Desk");
    expect(labels.get(HOST_KEY_B)).toBe("10.0.0.3:7422");

    // The name wins over a relay URL too.
    const relayLabels = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "named-relay")!.hosts);
    expect(relayLabels.get(HOST_KEY_A)).toBe("Desk");
  });

  it("disambiguates same-named hosts, lengthening the key prefix until unique", () => {
    const labels = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "same-name")!.hosts);
    expect(labels.get(HOST_KEY_A)).toBe(`Desk · ${HOST_KEY_A.slice(0, 6)}`);
    expect(labels.get(HOST_KEY_B)).toBe(`Desk · ${HOST_KEY_B.slice(0, 6)}`);

    // A host literally named like another's disambiguated label: the
    // disambiguation lengthens until no two labels collide.
    const shadowed = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "name-shadows-disambiguation")!.hosts);
    expect(shadowed.get(HOST_KEY_A)).toBe(`Desk · ${HOST_KEY_A.slice(0, 7)}`);
    expect(shadowed.get(HOST_KEY_B)).toBe(`Desk · ${HOST_KEY_B.slice(0, 6)}`);
    expect(shadowed.get(HOST_KEY_C)).toBe(`Desk · ${HOST_KEY_A.slice(0, 6)}`);
    expect(new Set(shadowed.values()).size).toBe(3);
  });

  it("disambiguates a name that equals another host's URL label", () => {
    const labels = hostLabels(HOST_LABEL_CASES.find((c) => c.name === "name-and-url-collide")!.hosts);
    expect(labels.get(HOST_KEY_A)).toBe(`10.0.0.3:7422 · ${HOST_KEY_A.slice(0, 6)}`);
    expect(labels.get(HOST_KEY_B)).toBe(`10.0.0.3:7422 · ${HOST_KEY_B.slice(0, 6)}`);
  });
});


describe("parseStoredHost endpoint sets", () => {
  const relay = { transport: "webSocket", role: "relay", url: "wss://relay.example.com/c/host" };
  const direct = { transport: "webSocket", role: "direct", url: "ws://192.168.1.5:7422/secure" };
  const set = (...endpoints: object[]) => ({ schemaVersion: 1, endpoints });

  it("keeps a valid remote set, including an explicit empty one", () => {
    const host = valid();
    expect(parseStoredHost({ ...host, endpointSet: set(relay, direct) })).toEqual({
      ...host,
      endpointSet: set(relay, direct),
    });
    expect(parseStoredHost({ ...host, endpointSet: set() })).toEqual({ ...host, endpointSet: set() });
  });

  it("dedupes identical entries and skips unknown transports", () => {
    const host = valid();
    const quic = { transport: "quic", role: "relay", url: "quic://relay" };
    expect(parseStoredHost({ ...host, endpointSet: set(relay, relay, quic) })).toEqual({
      ...host,
      endpointSet: set(relay),
    });
  });

  it("drops only the set when it is malformed or unsupported", () => {
    const host = valid();
    const bad = [
      "junk",
      { schemaVersion: 2, endpoints: [relay] },
      { schemaVersion: 1, endpoints: [{ ...relay, role: "backup" }] },
      { schemaVersion: 1, endpoints: [relay, { ...relay, role: "direct" }] },
      { schemaVersion: 1, endpoints: [{ transport: "quic", role: "relay", url: "quic://relay" }] },
    ];
    for (const endpointSet of bad) {
      expect(parseStoredHost({ ...host, endpointSet })).toEqual(host);
    }
  });

  it("leaves the legacy url and identity untouched when a set is present", () => {
    const host = { ...valid(), url: "ws://127.0.0.1:7420/secure" };
    const parsed = parseStoredHost({ ...host, endpointSet: set(relay) });
    expect(parsed).toEqual({ ...host, endpointSet: set(relay) });
  });
});
