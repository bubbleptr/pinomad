import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { parseStoredHost } from "../src/stored-host.ts";

const key = () => toBase64Url(generateKeyPair().privateKey);

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
