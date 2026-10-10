import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/noise.ts";
import { pairingFragment } from "../src/pairing-link.ts";
import { toBase64Url } from "../src/secure-channel.ts";

const hostKey = toBase64Url(generateKeyPair().publicKey);

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
