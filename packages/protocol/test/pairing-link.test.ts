import { describe, expect, it } from "vitest";
import { encodeEndpointSetParam, type EndpointSet, type HostEndpoint } from "../src/endpoints.ts";
import { generateKeyPair } from "../src/noise.ts";
import { pairingFragment, parsePairingLink } from "../src/pairing-link.ts";
import { toBase64Url } from "../src/secure-channel.ts";

const hostKey = toBase64Url(generateKeyPair().publicKey);

const relay: HostEndpoint = { transport: "webSocket", role: "relay", url: "wss://relay.example.com/c/host" };
const direct: HostEndpoint = { transport: "webSocket", role: "direct", url: "ws://192.168.1.5:7422/secure" };
const endpointSet = (...endpoints: HostEndpoint[]): EndpointSet => ({ schemaVersion: 1, endpoints });

describe("pairingFragment", () => {
  it("normalizes a pasted LAN link, resolving the socket against its origin", () => {
    expect(pairingFragment(`http://192.168.1.10:7420/#pair=${hostKey}.sec`)).toBe(
      `pair=${hostKey}.sec&url=${encodeURIComponent("ws://192.168.1.10:7420/")}`,
    );
    expect(pairingFragment(`https://pinomad.example.com/#pair=${hostKey}.sec`)).toBe(
      `pair=${hostKey}.sec&url=${encodeURIComponent("wss://pinomad.example.com/")}`,
    );
  });

  it("keeps an explicit url param (relay, loopback /secure)", () => {
    const relayTarget = encodeURIComponent("wss://relay.example.com/c/abc");
    expect(pairingFragment(`https://relay.example.com/#pair=${hostKey}.sec&url=${relayTarget}`)).toBe(
      `pair=${hostKey}.sec&url=${relayTarget}`,
    );
    const loopback = encodeURIComponent("ws://127.0.0.1:7420/secure");
    expect(pairingFragment(`http://127.0.0.1:7420/#pair=${hostKey}.sec&url=${loopback}`)).toBe(
      `pair=${hostKey}.sec&url=${loopback}`,
    );
  });

  it("emits only pair= and url= — a smuggled token (or anything else) is dropped", () => {
    const target = encodeURIComponent("wss://relay.example.com/c/abc");
    expect(
      pairingFragment(`pinomad://pair#pair=${hostKey}.sec&token=evil&url=${target}&extra=1`),
    ).toBe(`pair=${hostKey}.sec&url=${target}`);
  });

  it("accepts pinomad:// deep links, which must carry their own url", () => {
    const target = encodeURIComponent("ws://127.0.0.1:7420/secure");
    expect(pairingFragment(`pinomad://pair#pair=${hostKey}.sec&url=${target}`)).toBe(
      `pair=${hostKey}.sec&url=${target}`,
    );
    // pinomad:// has no usable origin to resolve a socket against.
    expect(pairingFragment(`pinomad://pair#pair=${hostKey}.sec`)).toBeUndefined();
  });

  it("requires the url to be a ws/wss socket", () => {
    expect(
      pairingFragment(`pinomad://pair#pair=${hostKey}.sec&url=${encodeURIComponent("http://x/")}`),
    ).toBeUndefined();
    expect(
      pairingFragment(`http://h/#pair=${hostKey}.sec&url=${encodeURIComponent("file:///etc")}`),
    ).toBeUndefined();
    expect(
      pairingFragment(`http://h/#pair=${hostKey}.sec&url=${encodeURIComponent("not a url")}`),
    ).toBeUndefined();
  });

  it("rejects token links and non-pairing text", () => {
    expect(pairingFragment(`http://127.0.0.1:5199/#token=abc`)).toBeUndefined();
    expect(pairingFragment("#pair=unlinked")).toBeUndefined();
    expect(pairingFragment("hello")).toBeUndefined();
    expect(pairingFragment("")).toBeUndefined();
    expect(pairingFragment(`http://127.0.0.1:7420/#pair=`)).toBeUndefined();
  });

  it("rejects malformed pair values exactly like resolveAddress", () => {
    expect(pairingFragment("http://h/#pair=nodot")).toBeUndefined();
    expect(pairingFragment("http://h/#pair=.nosecret")).toBeUndefined();
    expect(pairingFragment(`http://h/#pair=${hostKey}.a.b`)).toBeUndefined();
    expect(pairingFragment("http://h/#pair=!!!!.abc")).toBeUndefined();
    expect(pairingFragment(`http://h/#pair=${hostKey.slice(0, -4)}.abc`)).toBeUndefined();
  });
});


describe("endpoint candidates in pairing links", () => {
  it("preserves a valid remote set alongside the legacy url", () => {
    const encoded = encodeEndpointSetParam(endpointSet(relay, direct));
    const pasted = `https://relay.example.com/#pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${encoded}`;
    const parsed = parsePairingLink(pasted);
    expect(parsed?.url).toBe(relay.url);
    expect(parsed?.endpointSet).toEqual(endpointSet(relay, direct));
    expect(pairingFragment(pasted)).toBe(
      `pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${encoded}`,
    );
  });

  it("keeps a loopback legacy url separate from the remote set", () => {
    const encoded = encodeEndpointSetParam(endpointSet(relay));
    const loopback = "ws://127.0.0.1:7420/secure";
    const pasted = `pinomad://pair#pair=${hostKey}.sec&url=${encodeURIComponent(loopback)}&endpointSet=${encoded}`;
    expect(parsePairingLink(pasted)).toMatchObject({ url: loopback, endpointSet: endpointSet(relay) });
  });

  it("dedupes identical entries before re-emitting the set", () => {
    const deduped = encodeEndpointSetParam(endpointSet(relay));
    const pasted = `pinomad://pair#pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${encodeEndpointSetParam(endpointSet(relay, relay))}`;
    expect(pairingFragment(pasted)).toBe(
      `pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${deduped}`,
    );
  });

  it("rejects an explicit empty remote set", () => {
    const pasted = `pinomad://pair#pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${encodeEndpointSetParam(endpointSet())}`;
    expect(pairingFragment(pasted)).toBeUndefined();
    expect(parsePairingLink(pasted)).toBeUndefined();
  });

  it("rejects a malformed known set instead of partially adopting it", () => {
    const malformed = encodeEndpointSetParam({
      schemaVersion: 1,
      endpoints: [{ transport: "webSocket", role: "backup", url: relay.url }],
    } as unknown as EndpointSet);
    const pasted = `pinomad://pair#pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${malformed}`;
    expect(pairingFragment(pasted)).toBeUndefined();
    expect(parsePairingLink(pasted)).toBeUndefined();
  });

  it("rejects duplicate endpointSet parameters", () => {
    const encoded = encodeEndpointSetParam(endpointSet(relay));
    const pasted = `pinomad://pair#pair=${hostKey}.sec&url=${encodeURIComponent(relay.url)}&endpointSet=${encoded}&endpointSet=${encoded}`;
    expect(pairingFragment(pasted)).toBeUndefined();
    expect(parsePairingLink(pasted)).toBeUndefined();
  });

  it("falls back to the legacy url for an unknown schema or unsupported transport", () => {
    const target = encodeURIComponent(relay.url);
    const unknownSchema = encodeURIComponent(JSON.stringify({ schemaVersion: 2, endpoints: [relay] }));
    const unknownTransport = encodeURIComponent(
      JSON.stringify({ schemaVersion: 1, endpoints: [{ transport: "quic", role: "relay", url: "quic://relay" }] }),
    );
    for (const encoded of [unknownSchema, unknownTransport]) {
      const pasted = `pinomad://pair#pair=${hostKey}.sec&url=${target}&endpointSet=${encoded}`;
      expect(pairingFragment(pasted)).toBe(`pair=${hostKey}.sec&url=${target}`);
      expect(parsePairingLink(pasted)).toEqual({ hostKey, secret: "sec", url: relay.url });
    }
  });

  it("does not invent a set when the field is absent", () => {
    const target = encodeURIComponent(relay.url);
    expect(parsePairingLink(`pinomad://pair#pair=${hostKey}.sec&url=${target}`)).toEqual({
      hostKey,
      secret: "sec",
      url: relay.url,
    });
  });
});
