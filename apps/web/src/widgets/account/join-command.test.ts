// The expected commands live in a fixture shared with the server and iOS
// tests, so a fix to the command lands on every end at once (#518, #519).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { joinCommand } from "./join-command.ts";

interface JoinCommandCase {
  readonly name: string;
  readonly serverOrigin: string;
  readonly token: string | null;
  readonly command: string;
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "packages/protocol/test/fixtures/join-commands.json"), "utf8"),
) as { readonly cases: readonly JoinCommandCase[] };
// The page builds only the tokenless command; the token one comes from the server.
const tokenless = fixture.cases.filter((c) => c.token === null);

describe("joinCommand", () => {
  // The install script runs pinomad up itself, always naming this page's
  // server (the official one too), so a host joined elsewhere is refused
  // instead of kept there.
  it.each(tokenless)("$name", ({ serverOrigin, command }) => {
    expect(joinCommand(serverOrigin)).toBe(command);
  });
});
