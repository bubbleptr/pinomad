import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { pairingFragmentFromDeepLink } from "../electron/deep-link.ts";

const hostKey = toBase64Url(generateKeyPair().publicKey);
const ws = encodeURIComponent("ws://127.0.0.1:7420/secure");

describe("pairingFragmentFromDeepLink", () => {
  it("accepts pinomad://pair#… and emits the normalized fragment", () => {
    const fragment = `pair=${hostKey}.sec&url=${ws}`;
    expect(pairingFragmentFromDeepLink(`pinomad://pair#${fragment}`)).toBe(fragment);
  });

  it("drops a smuggled token — resolveAddress checks token before pair", () => {
    expect(pairingFragmentFromDeepLink(`pinomad://pair#pair=${hostKey}.sec&token=evil&url=${ws}`)).toBe(
      `pair=${hostKey}.sec&url=${ws}`,
    );
  });

  it("requires its own url param", () => {
    expect(pairingFragmentFromDeepLink(`pinomad://pair#pair=${hostKey}.sec`)).toBeUndefined();
  });

  it("ignores other hosts, schemes, and fragments without a valid pair", () => {
    expect(pairingFragmentFromDeepLink(`https://pair/#pair=${hostKey}.sec&url=${ws}`)).toBeUndefined();
    expect(pairingFragmentFromDeepLink(`pinomad://connect#pair=${hostKey}.sec&url=${ws}`)).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair#")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair#token=abc")).toBeUndefined();
    expect(pairingFragmentFromDeepLink(`pinomad://pair#url=${ws}`)).toBeUndefined();
    expect(pairingFragmentFromDeepLink(`pinomad://pair#pair=&url=${ws}`)).toBeUndefined();
    expect(pairingFragmentFromDeepLink("not a url")).toBeUndefined();
  });
});
