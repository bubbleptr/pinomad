import { describe, expect, it } from "vitest";
import { pairingFragmentFromDeepLink } from "../electron/deep-link.ts";

describe("pairingFragmentFromDeepLink", () => {
  it("accepts pinomad://pair#<fragment> with a pair param", () => {
    const fragment = "pair=hostkey.secr3t&url=ws%3A%2F%2F127.0.0.1%3A7420%2Fsecure";
    expect(pairingFragmentFromDeepLink(`pinomad://pair#${fragment}`)).toBe(fragment);
    expect(pairingFragmentFromDeepLink("pinomad://pair#pair=k.s")).toBe("pair=k.s");
  });

  it("ignores other hosts, schemes, and fragments without pair", () => {
    expect(pairingFragmentFromDeepLink("https://pair/#pair=k.s")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://connect#pair=k.s")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair#")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair#token=abc")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair#url=ws%3A%2F%2Fx")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("pinomad://pair#pair=")).toBeUndefined();
    expect(pairingFragmentFromDeepLink("not a url")).toBeUndefined();
  });
});
