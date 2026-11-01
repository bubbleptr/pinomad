// Host side of server accounts (ADR-0022 §3): join/leave CLI against a real
// in-process server, with an injected service manager — tests never install a
// real service.
import { readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { openAccounts, type Accounts } from "@pinomad/server/src/accounts.ts";
import { startRelay, type Relay } from "@pinomad/server/src/relay.ts";
import { loadHostKey, loadRelayKey } from "../src/devices.ts";
import { browserCommand } from "../src/cli/host-link.ts";
import { joinServer } from "../src/cli/join.ts";
import { leaveServer } from "../src/cli/leave.ts";
import { probeServerAccounts } from "../src/cli/server-ops.ts";
import { readServerBinding, readServerConfig, writeServerConfig } from "../src/server-config.ts";
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

async function startServer(options?: { readonly now?: () => number }): Promise<Started> {
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

  it("writes --name into settings.json, keeps the other keys, and reports the cleaned name", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    // An existing override plus a key this build doesn't know — both survive.
    await writeFile(
      join(data.path, "settings.json"),
      JSON.stringify({ followUpMode: "all", futureSetting: 42 }),
    );
    const fake = fakeManager();

    const outcome = await joinServer(
      { origin: started.origin, token: await joinToken(started), dataDir: data.path, name: "  Omarchy.local " },
      { manager: fake.manager },
    );

    expect(JSON.parse(await readFile(join(data.path, "settings.json"), "utf8"))).toEqual({
      followUpMode: "all",
      futureSetting: 42,
      hostName: "Omarchy",
    });
    expect(hostsRow(started.accounts, outcome.hostId)!.name).toBe("Omarchy");
  });

  it("reports the settings.json hostName when --name is absent", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    await writeFile(join(data.path, "settings.json"), JSON.stringify({ hostName: "stored-name" }));
    const outcome = await joinServer(
      { origin: started.origin, token: await joinToken(started), dataDir: data.path },
      { manager: fakeManager().manager },
    );
    expect(hostsRow(started.accounts, outcome.hostId)!.name).toBe("stored-name");
  });

  it("rejects a --name that cleans to nothing before spending the token", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const fake = fakeManager();
    await expect(
      joinServer(
        { origin: started.origin, token: await joinToken(started), dataDir: data.path, name: " .local " },
        { manager: fake.manager },
      ),
    ).rejects.toThrow(/invalid host name/i);
    // The token is unspent, no binding landed, and nothing was written.
    const db = new DatabaseSync(started.accounts.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hosts").get() as { n: number }).n).toBe(0);
    db.close();
    expect(fake.installs).toHaveLength(0);
    await expect(stat(join(data.path, "settings.json"))).rejects.toThrow();
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
    const old = await startRelay({ port: 0, publicOrigin: "http://127.0.0.1:0" });
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

  it("refuses to spend the token when the installed service belongs to another data dir", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const token = await joinToken(started);
    // The single service slot is occupied by a host on /srv/pinomad.
    const fake = fakeManager(seededSpec("/srv/pinomad", ["--relay", "https://old.example.com"]));
    await expect(
      joinServer({ origin: started.origin, token, dataDir: data.path }, { manager: fake.manager }),
    ).rejects.toThrow(/srv\/pinomad/);
    // The token is unspent and the definition untouched.
    expect(fake.installs).toHaveLength(0);
    const db = new DatabaseSync(started.accounts.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hosts").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT used_at AS u FROM join_tokens").get() as { u: number | null }).u).toBeNull();
    db.close();
  });

  it("refuses plaintext origins for account operations (loopback aside)", async () => {
    const data = await tempDir();
    defer(data.remove);
    const fake = fakeManager();
    await expect(
      joinServer({ origin: "http://relay.example.com", token: "tok", dataDir: data.path }, { manager: fake.manager }),
    ).rejects.toThrow(/https/);
    await expect(
      joinServer({ origin: "ws://relay.example.com", token: "tok", dataDir: data.path }, { manager: fake.manager }),
    ).rejects.toThrow(/https/);
    // A domain starting with "127." is a remote host — not the loopback
    // exception — so the join token must not ride plaintext to it.
    await expect(
      joinServer({ origin: "http://127.example.com", token: "tok", dataDir: data.path }, { manager: fake.manager }),
    ).rejects.toThrow(/https/);
    expect(await readServerConfig(data.path)).toBeUndefined();
  });
});

describe("joinServer without a token (#495)", () => {
  /**
   * The server's clock moves only when the host "sleeps" between polls, so
   * the poll schedule is deterministic. `onSleep` runs on each sleep with the
   * printed lines so far — where a test plays the person at the browser.
   */
  async function deviceFlow(options?: {
    readonly onSleep?: (call: number, lines: readonly string[], started: Started) => Promise<void>;
    /** Per sleep call, how far the server's clock moves (default: what was asked). */
    readonly advance?: (call: number, ms: number) => number;
    readonly seed?: ServiceSpec;
    /** How far the host's clock runs ahead of the server's. */
    readonly hostClockAheadMs?: number;
  }) {
    let at = 1_800_000_000_000;
    const started = await startServer({ now: () => at });
    const data = await tempDir();
    defer(data.remove);
    const fake = fakeManager(options?.seed);
    const lines: string[] = [];
    const sleeps: number[] = [];
    const opened: string[] = [];
    const requests: string[] = [];
    const deps = {
      manager: fake.manager,
      hostname: "omarchy",
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        requests.push(new URL(String(input)).pathname);
        return fetch(input, init);
      }) as typeof fetch,
      log: (line: string) => lines.push(line),
      now: () => at + (options?.hostClockAheadMs ?? 0),
      openBrowser: (url: string) => {
        opened.push(url);
        return true;
      },
      sleep: async (ms: number) => {
        const call = sleeps.push(ms) - 1;
        at += options?.advance?.(call, ms) ?? ms;
        await options?.onSleep?.(call, lines, started);
      },
    };
    return { started, data, fake, lines, sleeps, opened, requests, deps };
  }

  const codeIn = (lines: readonly string[]): string => {
    const match = /\b([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\b/.exec(lines.join("\n"));
    if (match === null) throw new Error(`no code printed:\n${lines.join("\n")}`);
    return match[1]!;
  };

  const asUser = async (started: Started, path: string, userCode: string) => {
    const login = await api(started.relay, { method: "POST", path: "/api/login", body: { username: "admin", password: GOOD_PASSWORD } });
    return api(started.relay, { method: "POST", path, headers: { authorization: `Bearer ${login.json.token}` }, body: { userCode } });
  };

  it("starts a host link, polls until a signed-in user confirms the code, then joins as before", async () => {
    const flow = await deviceFlow({
      onSleep: async (call, lines, started) => {
        if (call !== 1) return;
        const lookup = await asUser(started, "/api/host-link/lookup", codeIn(lines).toLowerCase());
        expect(lookup.json).toMatchObject({ name: "omarchy", os: expect.any(String) });
        expect((await asUser(started, "/api/host-link/confirm", codeIn(lines))).status).toBe(204);
      },
    });

    const outcome = await joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, flow.deps);

    expect(outcome.username).toBe("admin");
    expect(outcome.service).toBe("installed");
    expect(hostsRow(flow.started.accounts, outcome.hostId)?.name).toBe("omarchy");
    expect((await readServerConfig(flow.data.path))?.origin).toBe(flow.started.origin);
    // Printed: which server, where to go, the code, and this host's id.
    const printed = flow.lines.join("\n");
    expect(printed).toContain(flow.started.origin);
    expect(printed).toContain(`${flow.started.origin}/host-link`);
    expect(printed).toContain(outcome.hostId);
    // The browser opens on the page, never with the code in the URL.
    expect(flow.opened).toEqual([`${flow.started.origin}/host-link`]);
    expect(flow.opened[0]).not.toContain(codeIn(flow.lines));
    // Pending, pending, confirmed — one poll per interval.
    expect(flow.sleeps).toEqual([5000, 5000]);
    expect(flow.requests.filter((path) => path === "/api/host-link/poll")).toHaveLength(2);
  });

  it("adds 5 s to its interval when told to slow down", async () => {
    const flow = await deviceFlow({
      // The first two sleeps come up short on the server's clock: the second
      // poll arrives too early and gets slow_down.
      advance: (call, ms) => (call < 2 ? 1000 : ms),
      onSleep: async (call, lines, started) => {
        if (call === 2) await asUser(started, "/api/host-link/confirm", codeIn(lines));
      },
    });
    await joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, flow.deps);
    expect(flow.sleeps).toEqual([5000, 5000, 10000]);
  });

  it("stops with a clear error when the code is denied, and touches nothing", async () => {
    const flow = await deviceFlow({
      onSleep: async (call, lines, started) => {
        if (call === 0) await asUser(started, "/api/host-link/deny", codeIn(lines));
      },
    });
    await expect(joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, flow.deps)).rejects.toThrow(/denied/i);
    expect(await readServerConfig(flow.data.path)).toBeUndefined();
    expect(flow.fake.installs).toHaveLength(0);
  });

  it("stops with a clear error when nobody confirms in time", async () => {
    const flow = await deviceFlow();
    await expect(joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, flow.deps)).rejects.toThrow(/expired/i);
    expect(flow.fake.installs).toHaveLength(0);
  });

  it("checks the service slot before asking anyone to confirm", async () => {
    const flow = await deviceFlow({ seed: seededSpec("/srv/pinomad", []) });
    await expect(joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, flow.deps)).rejects.toThrow(/srv\/pinomad/);
    expect(flow.requests).not.toContain("/api/host-link/start");
    expect(flow.lines).toEqual([]);
  });

  it("leaves the token path alone: no host link is started", async () => {
    const flow = await deviceFlow();
    const token = await joinToken(flow.started);
    await joinServer({ origin: flow.started.origin, token, dataDir: flow.data.path }, flow.deps);
    expect(flow.requests.some((path) => path.startsWith("/api/host-link/"))).toBe(false);
    expect(flow.lines).toEqual([]);
    expect(flow.opened).toEqual([]);
  });

  it("says so when the server predates host links", async () => {
    const flow = await deviceFlow();
    const old = ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/host-link/start"
        ? Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }))
        : fetch(input, init)) as typeof fetch;
    await expect(
      joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, { ...flow.deps, fetch: old }),
    ).rejects.toThrow(/join token/i);
  });

  it("keeps waiting past its own clock's deadline while the server still says pending", async () => {
    // The host's clock is 5 min ahead: by its own reckoning the code died
    // long before the server's 10 min are up. Confirmed at 500 s server time.
    const flow = await deviceFlow({
      hostClockAheadMs: 5 * 60_000,
      onSleep: async (call, lines, started) => {
        if (call === 99) await asUser(started, "/api/host-link/confirm", codeIn(lines));
      },
    });
    const outcome = await joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, flow.deps);
    expect(outcome.username).toBe("admin");
    expect(flow.sleeps).toHaveLength(100);
  });

  it("gives up on its own clock when the server stops answering", async () => {
    const flow = await deviceFlow();
    const gone = ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/host-link/poll"
        ? Promise.reject(new TypeError("fetch failed"))
        : flow.deps.fetch(input, init)) as typeof fetch;
    await expect(
      joinServer({ origin: flow.started.origin, dataDir: flow.data.path }, { ...flow.deps, fetch: gone }),
    ).rejects.toThrow(/expired/i);
    // 10 min of code plus 2 min of grace, at one poll per 5 s.
    expect(flow.sleeps.length).toBeGreaterThan(140);
    expect(flow.fake.installs).toHaveLength(0);
  });

  /** Headers arrive, then the body trickles forever (a half-dead proxy). */
  const stalledBody = (): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"tok'));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("calls a start whose answer never finishes unreachable", async () => {
    const flow = await deviceFlow();
    for (const stall of [() => Promise.resolve(stalledBody()), () => new Promise<Response>(() => {})]) {
      const stalled = ((input: string | URL | Request, init?: RequestInit) =>
        new URL(String(input)).pathname === "/api/host-link/start" ? stall() : flow.deps.fetch(input, init)) as typeof fetch;
      await expect(
        joinServer(
          { origin: flow.started.origin, dataDir: flow.data.path },
          { ...flow.deps, fetch: stalled, requestTimeoutMs: 50 },
        ),
      ).rejects.toThrow(/cannot reach/i);
    }
  });

  it("asks again after a poll whose answer never finishes", async () => {
    const flow = await deviceFlow({
      onSleep: async (call, lines, started) => {
        if (call === 1) await asUser(started, "/api/host-link/confirm", codeIn(lines));
      },
    });
    let polls = 0;
    const stalled = ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/host-link/poll" && polls++ === 0
        ? Promise.resolve(stalledBody())
        : flow.deps.fetch(input, init)) as typeof fetch;
    const outcome = await joinServer(
      { origin: flow.started.origin, dataDir: flow.data.path },
      { ...flow.deps, fetch: stalled, requestTimeoutMs: 50 },
    );
    expect(outcome.username).toBe("admin");
    expect(polls).toBe(2);
  });
});

describe("browserCommand", () => {
  it("opens with `open` on macOS and `xdg-open` on a Linux desktop, and not over SSH or without a display", () => {
    expect(browserCommand("darwin", {})).toBe("open");
    expect(browserCommand("linux", { DISPLAY: ":0" })).toBe("xdg-open");
    expect(browserCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("xdg-open");
    expect(browserCommand("linux", {})).toBeUndefined();
    expect(browserCommand("darwin", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" })).toBeUndefined();
    expect(browserCommand("linux", { DISPLAY: ":0", SSH_TTY: "/dev/pts/1" })).toBeUndefined();
    expect(browserCommand("win32", {})).toBeUndefined();
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

  it("leaves a service bound to another data dir untouched", async () => {
    const started = await startServer();
    const data = await tempDir();
    defer(data.remove);
    const token = await joinToken(started);
    // Join first with no service, then pretend the slot belongs elsewhere.
    await joinServer({ origin: started.origin, token, dataDir: data.path }, { manager: fakeManager().manager });
    const foreign = fakeManager(seededSpec("/srv/pinomad", ["--relay", "https://x"]));
    const outcome = await leaveServer({ dataDir: data.path }, { manager: foreign.manager });
    expect(outcome.warnings).toEqual([]);
    expect(outcome.notes.join(" ")).toContain("/srv/pinomad");
    expect(foreign.installs).toHaveLength(0);
    expect(await readServerConfig(data.path)).toBeUndefined();
  });

  it("warns when the service definition can't be read", async () => {
    const data = await tempDir();
    defer(data.remove);
    await loadRelayKey(data.path);
    await writeFile(join(data.path, "server.json"), JSON.stringify({ origin: "http://127.0.0.1:1" }));
    const broken = fakeManager(seededSpec(data.path, []));
    broken.manager = { ...broken.manager, read: async () => { throw new Error("corrupt unit"); } };
    const outcome = await leaveServer({ dataDir: data.path }, { manager: broken.manager });
    expect(outcome.warnings.join(" ")).toMatch(/corrupt unit/);
    expect(await readServerConfig(data.path)).toBeUndefined();
  });
});

describe("probeServerAccounts", () => {
  const fakeFetch = (status: number, body?: string): typeof fetch =>
    (async () => new Response(body ?? "", { status })) as typeof fetch;

  it("reads the API's own answers, treats 404 as no-accounts, and 5xx as unreachable", async () => {
    expect(await probeServerAccounts("https://x", fakeFetch(401))).toBe("enabled");
    expect(await probeServerAccounts("https://x", fakeFetch(200, JSON.stringify({ user: { username: "a" } })))).toBe("enabled");
    // An old server's SPA fallback is a 200 without an account JSON.
    expect(await probeServerAccounts("https://x", fakeFetch(200, "<html>app</html>"))).toBe("disabled");
    expect(await probeServerAccounts("https://x", fakeFetch(404, '{"error":"accounts_disabled"}'))).toBe("disabled");
    // A proxy's failure says nothing about whether the server has accounts.
    expect(await probeServerAccounts("https://x", fakeFetch(502))).toBe("unreachable");
    expect(await probeServerAccounts("https://x", fakeFetch(403))).toBe("unreachable");
    expect(await probeServerAccounts("https://x", () => Promise.reject(new Error("ECONNREFUSED")) as never)).toBe("unreachable");
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

  it("stamps a fresh random binding on every write; a binding-less file reads but binds nothing", async () => {
    const data = await tempDir();
    defer(data.remove);
    await writeServerConfig(data.path, { origin: "https://x.example.com" });
    const first = await readServerConfig(data.path);
    expect(first?.binding).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await writeServerConfig(data.path, { origin: "https://x.example.com" });
    const second = await readServerConfig(data.path);
    expect(second!.binding).not.toBe(first!.binding);

    // Only a file written before `binding` existed: origin is honored, but no
    // account offer can mint under it.
    await writeFile(join(data.path, "server.json"), JSON.stringify({ origin: "https://x.example.com" }));
    expect((await readServerConfig(data.path))?.origin).toBe("https://x.example.com");
    expect(await readServerBinding(data.path)).toBeUndefined();
  });
});

