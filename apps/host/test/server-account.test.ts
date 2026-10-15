// Host side of server accounts (ADR-0022 §3): join/leave CLI against a real
// in-process server, with an injected service manager — tests never install a
// real service.
import { stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { openAccounts, type Accounts } from "@pinomad/relay/src/accounts.ts";
import { startRelay, type Relay } from "@pinomad/relay/src/relay.ts";
import { loadHostKey, loadRelayKey } from "../src/devices.ts";
import { joinServer } from "../src/cli/join.ts";
import { leaveServer } from "../src/cli/leave.ts";
import { readServerConfig } from "../src/server-config.ts";
import type { ServiceSpec } from "../src/service/definition.ts";
import type { ServiceManager } from "../src/service/manager.ts";
import { freePort, tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

const GOOD_PASSWORD = "correct horse battery";

interface Started {
  readonly relay: Relay;
  readonly accounts: Accounts;
  readonly origin: string;
}

async function startServer(): Promise<Started> {
  const dir = await tempDir();
  defer(dir.remove);
  const accounts = await openAccounts({ dataDir: dir.path, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
  // publicOrigin must be the address hosts dial — the register signs it.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const relay = await startRelay({ port, publicOrigin: origin, allowedHosts: [], accounts });
  defer(() => relay.close());
  return { relay, accounts, origin };
}

function api(relay: Relay, options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; json: Record<string, unknown> }> {
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
async function joinToken(started: Started): Promise<string> {
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
function fakeManager(seed?: ServiceSpec): { manager: ServiceManager; installs: ServiceSpec[]; restarts: () => number } {
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

const seededSpec = (dataDir: string, hostArgs: readonly string[]): ServiceSpec => ({
  nodePath: "/opt/node/bin/node",
  mainPath: "/pkg/dist/pinomad.js",
  entryArgs: ["host"],
  dataDir,
  hostArgs,
  env: { PATH: "/usr/bin" },
  home: "/home/u",
});

const hostsRow = (accounts: Accounts, hostId: string): Record<string, unknown> | undefined =>
  new DatabaseSync(accounts.dbPath).prepare("SELECT * FROM hosts WHERE host_id = ?").get(hostId) as Record<string, unknown> | undefined;

describe("joinServer", () => {
  it("joins a server account: binds the host, writes server.json, rewrites the service without --relay", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const token = await joinToken(started);
    // An installed service still carrying a legacy --relay argument.
    const fake = fakeManager(seededSpec(data.path, ["--relay", "https://old.example.com", "--port", "7420"]));

    const outcome = await joinServer({ origin: started.origin, token, dataDir: data.path, name: "omarchy" }, { manager: fake.manager });

    expect(outcome.username).toBe("admin");
    expect(outcome.service).toBe("updated");
    const row = hostsRow(started.accounts, outcome.hostId);
    expect(row).toBeDefined();
    expect(row!.name).toBe("omarchy");
    // The bound Noise key is this data dir's host-key — v2 made it trustworthy.
    expect(row!.noise_public_key).toBe(toBase64Url((await loadHostKey(data.path)).publicKey));
    expect((await readServerConfig(data.path))?.origin).toBe(started.origin);
    expect(fake.installs).toHaveLength(1);
    expect(fake.installs[0]!.hostArgs).toEqual(["--port", "7420"]);
    expect(fake.restarts()).toBe(0); // install() restarts; no second restart
  });

  it("installs a fresh service (no --relay) when none exists", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const fake = fakeManager();
    const outcome = await joinServer(
      { origin: started.origin, token: await joinToken(started), dataDir: data.path },
      { manager: fake.manager },
    );
    expect(outcome.service).toBe("installed");
    expect(fake.installs).toHaveLength(1);
    expect(fake.installs[0]!.dataDir).toBe(data.path);
    expect(fake.installs[0]!.hostArgs).toEqual([]);
  });

  it("fails before touching anything when the server has no accounts or is gone", async () => {
    const data = await tempDir();
    defer(data.remove);
    const fake = fakeManager();
    // Old-style relay: no accounts mounted.
    const old = await startRelay({ port: 0, publicOrigin: "http://127.0.0.1:0", allowedHosts: [] });
    defer(() => old.close());
    await expect(
      joinServer({ origin: old.url.replace(/^ws/, "http"), token: "tok", dataDir: data.path }, { manager: fake.manager }),
    ).rejects.toThrow(/too old|accounts/i);
    await expect(
      joinServer({ origin: "http://127.0.0.1:1", token: "tok", dataDir: data.path }, { manager: fake.manager }),
    ).rejects.toThrow(/reach/i);
    expect(await readServerConfig(data.path)).toBeUndefined();
    expect(fake.installs).toHaveLength(0);
  });

  it("leaves a spent-token error readable", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const token = await joinToken(started);
    const fake = fakeManager();
    await joinServer({ origin: started.origin, token, dataDir: data.path }, { manager: fake.manager });
    const again = await tempDir();
    defer(again.remove);
    await expect(
      joinServer({ origin: started.origin, token, dataDir: again.path }, { manager: fakeManager().manager }),
    ).rejects.toThrow(/invalid|spent/i);
  });
});

describe("leaveServer", () => {
  it("unbinds the server side, removes server.json, and strips --relay from the service", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const fake = fakeManager(seededSpec(data.path, ["--relay", started.origin, "--port", "7420"]));
    const joined = await joinServer(
      { origin: started.origin, token: await joinToken(started), dataDir: data.path },
      { manager: fake.manager },
    );

    const outcome = await leaveServer({ dataDir: data.path }, { manager: fake.manager });
    expect(outcome.warnings).toEqual([]);
    expect(hostsRow(started.accounts, joined.hostId)).toBeUndefined();
    expect(await readServerConfig(data.path)).toBeUndefined();
    expect(fake.installs.at(-1)!.hostArgs).toEqual(["--port", "7420"]);
  });

  it("still removes server.json when the server is unreachable, and says so", async () => {
    const data = await tempDir();
    defer(data.remove);
    await loadRelayKey(data.path);
    await loadHostKey(data.path);
    await writeFile(join(data.path, "server.json"), JSON.stringify({ origin: "http://127.0.0.1:1" }));
    const fake = fakeManager(seededSpec(data.path, []));

    const outcome = await leaveServer({ dataDir: data.path }, { manager: fake.manager });
    expect(await readServerConfig(data.path)).toBeUndefined();
    expect(outcome.warnings.join(" ")).toMatch(/not removed|may remain/i);
    // The host can't be dialing a server.json that no longer exists; restart still ran.
    expect(fake.restarts()).toBe(1);
  });

  it("refuses to leave when there is nothing to leave", async () => {
    const data = await tempDir();
    defer(data.remove);
    await expect(leaveServer({ dataDir: data.path }, { manager: fakeManager().manager })).rejects.toThrow(/not joined/);
  });
});

describe("loadHostKey", () => {
  it("creates a single 0600 X25519 key even for concurrent first calls", async () => {
    const data = await tempDir();
    defer(data.remove);
    const [a, b] = await Promise.all([loadHostKey(data.path), loadHostKey(data.path)]);
    expect(toBase64Url(a.privateKey)).toBe(toBase64Url(b.privateKey));
    expect(toBase64Url((await loadHostKey(data.path)).privateKey)).toBe(toBase64Url(a.privateKey));
    expect((await stat(join(data.path, "host-key"))).mode & 0o777).toBe(0o600);
  });
});

describe("server.json", () => {
  it("round-trips and rejects malformed files", async () => {
    const data = await tempDir();
    defer(data.remove);
    expect(await readServerConfig(data.path)).toBeUndefined();
    await writeFile(join(data.path, "server.json"), "{ not json");
    await expect(readServerConfig(data.path)).rejects.toThrow(/not valid JSON/);
    await writeFile(join(data.path, "server.json"), JSON.stringify({ origin: 5 }));
    await expect(readServerConfig(data.path)).rejects.toThrow(/origin/);
  });
});

