import { describe, expect, it } from "vitest";
import { OFFICIAL_SERVER_ORIGIN } from "../../shared/official-server.ts";
import { joinCommand } from "./add-host.tsx";

describe("joinCommand", () => {
  it("installs with the script and runs pinomad up, which defaults to the official server", () => {
    expect(joinCommand(OFFICIAL_SERVER_ORIGIN)).toBe("curl -fsSL https://pinomad.si/install.sh | sh\n~/.local/bin/pinomad up");
  });

  it("names any other server, or up would join the host to the official one", () => {
    expect(joinCommand("https://nomad.example")).toBe(
      "curl -fsSL https://pinomad.si/install.sh | sh\n~/.local/bin/pinomad up --origin https://nomad.example",
    );
  });
});
