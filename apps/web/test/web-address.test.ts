import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_URL, deviceName, resolveAddress, servedByHost } from "../src/address.ts";
import { hostLabels } from "../src/entities/host/host-store.ts";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";

const http = { protocol: "http:", host: "127.0.0.1:5199" };
const https = { protocol: "https:", host: "pinomad.example.com" };
const hostKey = toBase64Url(generateKeyPair().publicKey);
const deviceKey = toBase64Url(generateKeyPair().privateKey);
const hostKeyB = toBase64Url(generateKeyPair().publicKey);
const deviceKeyB = toBase64Url(generateKeyPair().privateKey);
const storedA = { url: "ws://10.0.0.2:7422", hostKey, privateKey: deviceKey };
const storedB = { url: "ws://10.0.0.3:7422", hostKey: hostKeyB, privateKey: deviceKeyB };

describe("resolveAddress", () => {
  it("parses a token link", () => {
    expect(resolveAddress("#token=abc", http, [], null)).toEqual({ kind: "token", url: DEFAULT_HOST_URL, token: "abc" });
    expect(resolveAddress("#token=a%2Bb&url=ws%3A%2F%2F127.0.0.1%3A9000", http, [], null)).toEqual({
      kind: "token",
      url: "ws://127.0.0.1:9000",
      token: "a+b",
    });
    // A token fragment wins over stored hosts.
    expect(resolveAddress("#token=abc", http, [storedA], storedA.hostKey)).toMatchObject({ kind: "token" });
  });

  it("parses a pairing fragment", () => {
    const resolved = resolveAddress(`#pair=${hostKey}.s3cr3t-0`, https, [], null);
    expect(resolved).toEqual({ kind: "pair", url: "wss://pinomad.example.com/", hostKey, secret: "s3cr3t-0" });
    // http pages dial ws; an explicit url overrides the same-origin default.
    expect(resolveAddress(`#pair=${hostKey}.abc&url=ws%3A%2F%2F127.0.0.1%3A7422`, http, [storedA], null)).toEqual({
      kind: "pair",
      url: "ws://127.0.0.1:7422",
      hostKey,
      secret: "abc",
    });
  });

  it("rejects malformed pair fragments", () => {
    expect(resolveAddress("#pair=nodot", http, [], null)).toBeUndefined();
    expect(resolveAddress("#pair=.nosecret", http, [], null)).toBeUndefined();
    expect(resolveAddress(`#pair=${hostKey}.a.b`, http, [], null)).toBeUndefined();
    expect(resolveAddress("#pair=!!!!.abc", http, [], null)).toBeUndefined();
    expect(resolveAddress(`#pair=${hostKey.slice(0, -4)}.abc`, http, [], null)).toBeUndefined();
    // A malformed fragment stays unresolved even with hosts stored.
    expect(resolveAddress("#pair=nodot", http, [storedA], storedA.hostKey)).toBeUndefined();
  });

  it("connects to the active host when there is no fragment", () => {
    expect(resolveAddress("", http, [storedA], null)).toEqual({ kind: "device", ...storedA });
    expect(resolveAddress("", http, [storedA, storedB], storedB.hostKey)).toEqual({ kind: "device", ...storedB });
  });

  it("falls back to the first host when the active key isn't stored", () => {
    expect(resolveAddress("", http, [storedA, storedB], "not-a-stored-key")).toEqual({ kind: "device", ...storedA });
    expect(resolveAddress("", http, [storedA, storedB], null)).toEqual({ kind: "device", ...storedA });
  });

  it("returns undefined with an empty host list", () => {
    expect(resolveAddress("", http, [], null)).toBeUndefined();
    expect(resolveAddress("", http, [], hostKey)).toBeUndefined();
  });
});

// pairingFragment's cases live with the shared rule in
// packages/protocol/test/pairing-link.test.ts.
describe("servedByHost", () => {
  it("is true only when the page and the gateway share host:port", () => {
    expect(servedByHost("ws://127.0.0.1:7420", { host: "127.0.0.1:7420" })).toBe(true);
    expect(servedByHost("wss://pinomad.example.com", { host: "pinomad.example.com" })).toBe(true);
    // Same host, different port: the vite dev server is not the host.
    expect(servedByHost("ws://127.0.0.1:7420", { host: "127.0.0.1:5199" })).toBe(false);
    expect(servedByHost("ws://192.168.1.5:7422", { host: "127.0.0.1:5199" })).toBe(false);
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

describe("deviceName", () => {
  it("names the browser for the device list", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone Safari");
    expect(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")).toBe("Android Chrome");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")).toBe("Mac Chrome");
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")).toBe("Windows Edge");
    expect(deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("Linux Firefox");
    expect(deviceName("curl/8.7.1")).toBe("Browser");
  });
});
