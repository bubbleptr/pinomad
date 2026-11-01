// The in-process server and fake service manager the host's account CLI tests
// share (join, leave, up): tests never install a real service.
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openAccounts, type Accounts } from "@pinomad/server/src/accounts.ts";
import { startRelay, type Relay } from "@pinomad/server/src/relay.ts";
import type { ServiceSpec } from "../src/service/definition.ts";
import type { ServiceManager } from "../src/service/manager.ts";
import { freePort, tempDir, useCleanups } from "./support.ts";

// Registers its afterEach in each test file that imports this module.
const defer = useCleanups();

export const GOOD_PASSWORD = "correct horse battery";

export interface Started {
  readonly relay: Relay;
  readonly accounts: Accounts;
  readonly origin: string;
}

export async function startServer(options?: { readonly now?: () => number }): Promise<Started> {
  const dir = await tempDir();
  defer(dir.remove);
  const accounts = await openAccounts({
    dataDir: dir.path,
    bootstrapUser: "admin",
    bootstrapPassword: GOOD_PASSWORD,
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  // publicOrigin must be the address hosts dial — the register signs it.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const relay = await startRelay({ port, publicOrigin: origin, accounts });
  defer(() => relay.close());
  return { relay, accounts, origin };
}

export function api(relay: Relay, options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

/** A join token straight from the API, the way the web UI would mint it. */
export async function joinToken(started: Started): Promise<string> {
  const login = await api(started.relay, { method: "POST", path: "/api/login", body: { username: "admin", password: GOOD_PASSWORD } });
  const minted = await api(started.relay, {
    method: "POST",
    path: "/api/join-tokens",
    headers: { authorization: `Bearer ${login.json.token}` },
  });
  return minted.json.token as string;
}

/**
 * A ServiceManager that never touches the OS: installs are recorded and the
 * "installed" state is whatever spec was seeded or last installed.
 */
export function fakeManager(seed?: ServiceSpec): { manager: ServiceManager; installs: ServiceSpec[]; restarts: () => number } {
  const installs: ServiceSpec[] = [];
  let spec = seed;
  let restarts = 0;
  return {
    installs,
    restarts: () => restarts,
    manager: {
      async install(next) {
        installs.push(next);
        spec = next;
        return "/fake/pinomad.service";
      },
      async uninstall() {
        spec = undefined;
      },
      async restart() {
        restarts += 1;
      },
      async state() {
        return { installed: spec !== undefined, running: spec !== undefined, detail: spec === undefined ? "not installed" : "running" };
      },
      async logs() {},
      async read() {
        return spec;
      },
    },
  };
}

export const seededSpec = (dataDir: string, hostArgs: readonly string[]): ServiceSpec => ({
  nodePath: "/opt/node/bin/node",
  mainPath: "/pkg/dist/pinomad.js",
  entryArgs: ["host"],
  dataDir,
  hostArgs,
  env: { PATH: "/usr/bin" },
  home: "/home/u",
});

export const hostsRow = (accounts: Accounts, hostId: string): Record<string, unknown> | undefined =>
  new DatabaseSync(accounts.dbPath).prepare("SELECT * FROM hosts WHERE host_id = ?").get(hostId) as Record<string, unknown> | undefined;

/** The short code a host link printed. */
export const codeIn = (lines: readonly string[]): string => {
  const match = /\b([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\b/.exec(lines.join("\n"));
  if (match === null) throw new Error(`no code printed:\n${lines.join("\n")}`);
  return match[1]!;
};

/** A signed-in admin calling a host-link endpoint with `userCode`. */
export const asUser = async (started: Started, path: string, userCode: string) => {
  const login = await api(started.relay, { method: "POST", path: "/api/login", body: { username: "admin", password: GOOD_PASSWORD } });
  return api(started.relay, { method: "POST", path, headers: { authorization: `Bearer ${login.json.token}` }, body: { userCode } });
};
