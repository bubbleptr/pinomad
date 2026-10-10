import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_URL, deviceName, resolveAddress, servedByHost } from "../src/address.ts";
import { generateKeyPair, keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";

const http = { protocol: "http:", host: "127.0.0.1:5199" };
const https = { protocol: "https:", host: "pinomad.example.com" };
const hostKey = toBase64Url(generateKeyPair().publicKey);
const deviceKey = toBase64Url(generateKeyPair().privateKey);

describe("resolveAddress", () => {
  it("parses a token link", () => {
    expect(resolveAddress("#token=abc", http, null)).toEqual({ kind: "token", url: DEFAULT_HOST_URL, token: "abc" });
    expect(resolveAddress("#token=a%2Bb&url=ws%3A%2F%2F127.0.0.1%3A9000", http, null)).toEqual({
      kind: "token",
      url: "ws://127.0.0.1:9000",
      token: "a+b",
    });
    // A token fragment wins over a stored device.
    expect(resolveAddress("#token=abc", http, JSON.stringify({ url: "w", hostKey, privateKey: deviceKey }))).toMatchObject({
      kind: "token",
    });
  });

  it("parses a pairing fragment", () => {
    const resolved = resolveAddress(`#pair=${hostKey}.s3cr3t-0`, https, null);
    expect(resolved).toEqual({ kind: "pair", url: "wss://pinomad.example.com/", hostKey, secret: "s3cr3t-0" });
    // http pages dial ws; an explicit url overrides the same-origin default.
    expect(resolveAddress(`#pair=${hostKey}.abc&url=ws%3A%2F%2F127.0.0.1%3A7422`, http, null)).toEqual({
      kind: "pair",
      url: "ws://127.0.0.1:7422",
      hostKey,
      secret: "abc",
    });
  });

  it("rejects malformed pair fragments", () => {
    expect(resolveAddress("#pair=nodot", http, null)).toBeUndefined();
    expect(resolveAddress("#pair=.nosecret", http, null)).toBeUndefined();
    expect(resolveAddress(`#pair=${hostKey}.a.b`, http, null)).toBeUndefined();
    expect(resolveAddress("#pair=!!!!.abc", http, null)).toBeUndefined();
    expect(resolveAddress(`#pair=${hostKey.slice(0, -4)}.abc`, http, null)).toBeUndefined();
  });

  it("uses the stored device when there is no fragment", () => {
    const stored = JSON.stringify({ url: "ws://10.0.0.2:7422", hostKey, privateKey: deviceKey });
    expect(resolveAddress("", http, stored)).toEqual({
      kind: "device",
      url: "ws://10.0.0.2:7422",
      hostKey,
      privateKey: deviceKey,
    });
    expect(resolveAddress("", http, null)).toBeUndefined();
    expect(resolveAddress("", http, "not json")).toBeUndefined();
    expect(resolveAddress("", http, JSON.stringify({ url: "w" }))).toBeUndefined();
    expect(resolveAddress("", http, JSON.stringify({ url: "w", hostKey: "!!", privateKey: deviceKey }))).toBeUndefined();
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
