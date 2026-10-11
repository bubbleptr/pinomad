import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { hostLabels, parseStoredHost } from "../src/stored-host.ts";

const key = () => toBase64Url(generateKeyPair().privateKey);

const hostKey = toBase64Url(generateKeyPair().publicKey);
const deviceKey = toBase64Url(generateKeyPair().privateKey);
const hostKeyB = toBase64Url(generateKeyPair().publicKey);
const deviceKeyB = toBase64Url(generateKeyPair().privateKey);
const storedA = { url: "ws://10.0.0.2:7422", hostKey, privateKey: deviceKey };
const storedB = { url: "ws://10.0.0.3:7422", hostKey: hostKeyB, privateKey: deviceKeyB };

const valid = () => ({
  url: "ws://192.168.1.5:7422/secure",
  hostKey: key(),
  privateKey: key(),
});

describe("parseStoredHost", () => {
  it("round-trips a valid entry", () => {
    const host = valid();
    expect(parseStoredHost({ ...host })).toEqual(host);
    expect(parseStoredHost({ ...host, url: "wss://relay.example.com/c/host" })).toEqual({
      ...host,
      url: "wss://relay.example.com/c/host",
    });
  });

  it("strips extra fields", () => {
    const host = valid();
    expect(parseStoredHost({ ...host, name: "host-a", nested: { x: 1 } })).toEqual(host);
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
});

describe("hostLabels", () => {
  it("labels each host by its URL host", () => {
    const labels = hostLabels([storedA, storedB]);
    expect(labels.get(storedA.hostKey)).toBe("10.0.0.2:7422");
    expect(labels.get(storedB.hostKey)).toBe("10.0.0.3:7422");
  });

  it("disambiguates hosts sharing a host (two hosts on one relay)", () => {
    const relayA = { url: "wss://relay.example.com/c/host-a", hostKey, privateKey: deviceKey };
    const relayB = { url: "wss://relay.example.com/c/host-b", hostKey: hostKeyB, privateKey: deviceKeyB };
    const labels = hostLabels([relayA, relayB]);
    expect(labels.get(relayA.hostKey)).toBe(`relay.example.com · ${hostKey.slice(0, 6)}`);
    expect(labels.get(relayB.hostKey)).toBe(`relay.example.com · ${hostKeyB.slice(0, 6)}`);
    // A third host on its own URL keeps the plain label.
    const labels3 = hostLabels([relayA, relayB, storedA]);
    expect(labels3.get(storedA.hostKey)).toBe("10.0.0.2:7422");
  });
});
