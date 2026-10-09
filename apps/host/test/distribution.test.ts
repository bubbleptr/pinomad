import { describe, expect, it } from "vitest";
import { globalPrefixOf } from "../src/distribution.ts";

describe("globalPrefixOf", () => {
  it("maps an installed package dir back to its npm global prefix", () => {
    expect(globalPrefixOf("/opt/pinomad/lib/node_modules/pinomad/")).toBe("/opt/pinomad");
    expect(globalPrefixOf("/usr/lib/node_modules/pinomad")).toBe("/usr");
    expect(globalPrefixOf("/Users/x/.nvm/versions/node/v25.0.0/lib/node_modules/pinomad/")).toBe(
      "/Users/x/.nvm/versions/node/v25.0.0",
    );
  });

  it("returns undefined for non-global installs (source checkout, npm link, local dep)", () => {
    expect(globalPrefixOf("/Users/x/code/pinomad/apps/cli/out/")).toBeUndefined();
    expect(globalPrefixOf("/opt/lib/node_modules/other/")).toBeUndefined();
  });
});
