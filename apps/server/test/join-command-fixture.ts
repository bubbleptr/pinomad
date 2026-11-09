// The join commands every end builds, read from the fixture shared with the web
// and iOS tests (#518, #519). The server returns only the one-use token command;
// the clients build the tokenless one.
import { readFileSync } from "node:fs";

export interface JoinCommandCase {
  readonly name: string;
  readonly serverOrigin: string;
  readonly token: string | null;
  readonly command: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/protocol/test/fixtures/join-commands.json", import.meta.url), "utf8"),
) as { readonly cases: readonly JoinCommandCase[] };

export const tokenJoinCommands = fixture.cases.filter(
  (c): c is JoinCommandCase & { readonly token: string } => c.token !== null,
);

/** A fixture command with its token placeholder replaced by the minted token. */
export function fillJoinCommand(entry: JoinCommandCase & { readonly token: string }, token: string): string {
  return entry.command.replace(entry.token, token);
}
