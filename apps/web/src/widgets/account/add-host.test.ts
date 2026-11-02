import { describe, expect, it } from "vitest";
import { joinCommand } from "./add-host.tsx";

describe("joinCommand", () => {
  // The install script runs pinomad up itself, always for this page's
  // server, so a host joined elsewhere is refused instead of kept there.
  it("has the install script run pinomad up, naming this server", () => {
    expect(joinCommand("https://app.pinomad.si/")).toBe(
      "curl -fsSL https://pinomad.si/install.sh | sh -s -- up --origin https://app.pinomad.si",
    );
  });
});
