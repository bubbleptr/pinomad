import { describe, expect, it } from "vitest";
import { joinCommand } from "./add-host.tsx";

describe("joinCommand", () => {
  // The script's launcher when it made one, else a pinomad already installed
  // with npm (the script leaves that alone); and always this page's server,
  // so a host joined elsewhere is refused instead of kept there.
  it("runs pinomad up from either install, naming this server", () => {
    expect(joinCommand("https://app.pinomad.si/")).toBe(
      'curl -fsSL https://pinomad.si/install.sh | sh\nPATH="$HOME/.local/bin:$PATH" pinomad up --origin https://app.pinomad.si',
    );
  });
});
