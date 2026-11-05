// The join command POST /api/join-tokens returns, checked against the fixture
// the web and iOS tests read too, so a fix to the command lands on every end
// at once (#518, #519).
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openAccounts } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { removeTempDir, tempDir } from "./support.ts";

interface JoinCommandCase {
  readonly name: string;
  readonly serverOrigin: string;
  readonly token: string | null;
  readonly command: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/protocol/test/fixtures/join-commands.json", import.meta.url), "utf8"),
) as { readonly cases: readonly JoinCommandCase[] };
// The server builds only the one-use token command; the clients build the tokenless one.
const withToken = fixture.cases.filter(
  (c): c is JoinCommandCase & { readonly token: string } => c.token !== null,
);

const PASSWORD = "correct horse battery";

const dirs: string[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function post(relay: Relay, path: string, options: { readonly bearer?: string; readonly body?: unknown }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: relay.port,
        path,
        method: "POST",
        headers: options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) reject(new Error(`${path} returned ${response.statusCode}`));
          else resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

describe("join command", () => {
  it.each(withToken)("$name", async ({ serverOrigin, token: placeholder, command }) => {
    const dataDir = await tempDir(dirs);
    const accounts = await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: PASSWORD });
    const relay = await startRelay({ port: 0, publicOrigin: serverOrigin, accounts });
    relays.push(relay);
    const session = (await post(relay, "/api/login", { body: { username: "admin", password: PASSWORD } })).token as string;
    const minted = await post(relay, "/api/join-tokens", { bearer: session });
    expect(minted.command).toBe(command.replace(placeholder, minted.token as string));
  });
});
