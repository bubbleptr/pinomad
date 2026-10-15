import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  decodeRelayToHost,
  encodeRelayFrame,
  RELAY_CLOSE,
  relayHostId,
  signRelayChallenge,
  type HostToRelay,
} from "@pinomad/protocol/relay.ts";
import { changePassword, openAccounts, type Accounts, type LoginLimits } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";

const ORIGIN = "https://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a different long password";
const DAY = 24 * 60 * 60 * 1000;
const WRONG = "wrong password here";

const dirs: string[] = [];
const relays: Relay[] = [];
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-server-"));
  dirs.push(dir);
  return dir;
}

interface Started {
  readonly relay: Relay;
  readonly accounts: Accounts;
  readonly dataDir: string;
}

/**
 * openAccounts + startRelay wired the way main.ts does. `bootstrap` mirrors the
 * PINOMAD_SERVER_USER/PASSWORD env pair; `bootstrap: {}` simulates a restart
 * where the user already exists and no env vars are set.
 */
async function startServer(options?: {
  readonly dataDir?: string;
  readonly bootstrap?: { readonly user?: string; readonly password?: string };
  readonly trustProxy?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly webRoot?: string;
  readonly now?: () => number;
  readonly limits?: LoginLimits;
  readonly lockStaleMs?: number;
}): Promise<Started> {
  const dataDir = options?.dataDir ?? (await tempDir());
  const bootstrap = options?.bootstrap ?? { user: "admin", password: GOOD_PASSWORD };
  const accounts = await openAccounts({
    dataDir,
    bootstrapUser: bootstrap.user,
    bootstrapPassword: bootstrap.password,
    now: options?.now,
    limits: options?.limits,
    lockStaleMs: options?.lockStaleMs,
  });
  const relay = await startRelay({
    port: 0,
    publicOrigin: ORIGIN,
    allowedHosts: options?.allowedHosts ?? [],
    acceptTimeoutMs: 150,
    registerTimeoutMs: 150,
    webRoot: options?.webRoot,
    accounts,
    trustProxy: options?.trustProxy ?? false,
  });
  relays.push(relay);
  return { relay, accounts, dataDir };
}

/** Closes a started server without the afterEach sweep double-closing it. */
async function stop(started: Started): Promise<void> {
  const index = relays.indexOf(started.relay);
  if (index >= 0) relays.splice(index, 1);
  await started.relay.close();
}

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly json: Record<string, unknown>;
}

function api(
  relay: Relay,
  options: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  },
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Plain-text or empty bodies surface as {} — tests assert on status for those.
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, json });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    request.end();
  });
}

const login = (
  relay: Relay,
  username = "admin",
  password = GOOD_PASSWORD,
  headers?: Record<string, string>,
): Promise<ApiResponse> => api(relay, { method: "POST", path: "/api/login", headers, body: { username, password } });

/** The `name=value` pair of the session cookie a login response sets. */
const sessionCookie = (response: ApiResponse): string => {
  const cookies = response.headers["set-cookie"] as string[] | undefined;
  if (cookies === undefined || cookies.length === 0) throw new Error("expected a Set-Cookie header");
  return cookies[0]!.split(";")[0]!;
};

const asText = (data: unknown): string => (data as Buffer).toString();

type KeyPair = ReturnType<typeof ed25519.keygen>;

/**
 * Answers the register challenge and resolves to "registered" or the close code
 * the server ended the socket with. The close/error listeners attach before
 * `open` resolves so neither event can be missed.
 */
async function tryRegister(relay: Relay, keys: KeyPair): Promise<"registered" | number> {
  const socket = new WebSocket(`${relay.url}/host`);
  sockets.add(socket);
  const closedP = once(socket, "close").then(([code]) => code as number);
  void once(socket, "error").catch(() => {}); // an error is always followed by close
  // The challenge arrives during the upgrade; the listener must go up before `open`.
  const challengeP = once(socket, "message");
  await once(socket, "open");
  const challenge = decodeRelayToHost(asText((await challengeP)[0]));
  if (challenge.t !== "challenge") throw new Error("expected challenge");
  const hostId = relayHostId(keys.publicKey);
  const register: HostToRelay = { t: "register", hostId, signature: signRelayChallenge(keys.secretKey, { relayOrigin: ORIGIN, hostId, nonce: challenge.nonce }) };
  socket.send(encodeRelayFrame(register));
  const result = await Promise.race([
    once(socket, "message").then(([data]) => (decodeRelayToHost(asText(data)).t === "registered" ? ("registered" as const) : -1)),
    closedP,
  ]);
  socket.close();
  return result;
}

describe("server bootstrap", () => {
  it("creates the first user from the bootstrap credentials", async () => {
    const { relay } = await startServer({ bootstrap: { user: "admin", password: GOOD_PASSWORD } });
    const response = await login(relay);
    expect(response.status).toBe(200);
    expect((response.json.user as Record<string, unknown>).username).toBe("admin");
    expect(typeof response.json.token).toBe("string");
  });

  it("refuses to start when a bootstrap credential is missing or the password is weak", async () => {
    const dir = await tempDir();
    await expect(openAccounts({ dataDir: dir })).rejects.toThrow();
    await expect(openAccounts({ dataDir: dir, bootstrapUser: "admin" })).rejects.toThrow();
    await expect(openAccounts({ dataDir: dir, bootstrapPassword: GOOD_PASSWORD })).rejects.toThrow();
    await expect(openAccounts({ dataDir: dir, bootstrapUser: "admin", bootstrapPassword: "short" })).rejects.toThrow();
    // Credentials outside the login endpoint's bounds would mint an account nobody can log into.
    await expect(openAccounts({ dataDir: dir, bootstrapUser: "", bootstrapPassword: GOOD_PASSWORD })).rejects.toThrow();
    await expect(openAccounts({ dataDir: dir, bootstrapUser: "admin", bootstrapPassword: "x".repeat(2000) })).rejects.toThrow();
    // A failed bootstrap must release the lock so a retry can succeed.
    const accounts = await openAccounts({ dataDir: dir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
    await accounts.close();
  });

  it("persists users and sessions across a restart", async () => {
    const dir = await tempDir();
    const first = await startServer({ dataDir: dir });
    const token = (await login(first.relay)).json.token as string;
    await stop(first);

    const second = await startServer({ dataDir: dir, bootstrap: {} });
    const me = await api(second.relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect((await login(second.relay)).status).toBe(200);
  });

  it("refuses a second process on the same data directory", async () => {
    const dir = await tempDir();
    // Same stale value on both sides — a shorter contender-side stale would
    // mistake the live lock for an abandoned one and steal it.
    await startServer({ dataDir: dir, lockStaleMs: 2000 });
    await expect(
      openAccounts({ dataDir: dir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD, lockStaleMs: 2000 }),
    ).rejects.toThrow(/already in use|held/i);
  });
});

describe("server login and sessions", () => {
  it("accepts correct credentials, rejects wrong and unknown ones identically", async () => {
    const { relay } = await startServer();
    const wrong = await login(relay, "admin", WRONG);
    expect(wrong.status).toBe(401);
    const unknown = await login(relay, "nobody", WRONG);
    expect(unknown.status).toBe(401);
    // Same error shape either way — the API must not disclose which usernames exist.
    expect(unknown.json).toEqual(wrong.json);

    // No Origin (native clients, CLI): bare token, no cookie.
    const tokenResponse = await login(relay);
    expect(tokenResponse.status).toBe(200);
    expect(typeof tokenResponse.json.token).toBe("string");
    expect(tokenResponse.headers["set-cookie"]).toBeUndefined();

    // Same-origin browser login: HttpOnly cookie only, the body must not leak
    // the session token to page JS.
    const cookieResponse = await login(relay, "admin", GOOD_PASSWORD, { origin: ORIGIN });
    expect(cookieResponse.status).toBe(200);
    expect(cookieResponse.json.token).toBeUndefined();
    const setCookie = (cookieResponse.headers["set-cookie"] as string[])[0]!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");

    const cookie = sessionCookie(cookieResponse);
    expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${tokenResponse.json.token}` } })).status).toBe(200);
    expect((await api(relay, { path: "/api/me", headers: { cookie, origin: ORIGIN } })).status).toBe(200);
    expect((await api(relay, { path: "/api/me" })).status).toBe(401);
  });

  it("expires sessions at a fixed 30 days with no sliding renewal", async () => {
    let now = 1_800_000_000_000;
    const { relay } = await startServer({ now: () => now });
    const token = (await login(relay)).json.token as string;
    const me = () => api(relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } });

    now += 29 * DAY;
    // Using the session near the end must not push the deadline out.
    expect((await me()).status).toBe(200);
    now += 2 * DAY;
    expect((await me()).status).toBe(401);
  });

  it("invalidates the token on logout", async () => {
    const { relay } = await startServer();
    const token = (await login(relay)).json.token as string;
    const auth = { authorization: `Bearer ${token}` };
    expect((await api(relay, { path: "/api/me", headers: auth })).status).toBe(200);
    expect((await api(relay, { method: "POST", path: "/api/logout", headers: auth })).status).toBe(204);
    expect((await api(relay, { path: "/api/me", headers: auth })).status).toBe(401);
    // Logging out again with the dead token is just unauthenticated.
    expect((await api(relay, { method: "POST", path: "/api/logout", headers: auth })).status).toBe(401);
  });

  it("revoke-all invalidates every session of the account", async () => {
    const { relay } = await startServer();
    const first = (await login(relay)).json.token as string;
    const second = (await login(relay)).json.token as string;
    const response = await api(relay, {
      method: "POST",
      path: "/api/sessions/revoke-all",
      headers: { authorization: `Bearer ${first}` },
    });
    expect(response.status).toBe(204);
    for (const token of [first, second]) {
      expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    }
  });

  it("rejects cross-origin mutating requests on the cookie path, not on Bearer", async () => {
    const { relay } = await startServer();
    const cookie = sessionCookie(await login(relay, "admin", GOOD_PASSWORD, { origin: ORIGIN }));
    const token = (await login(relay)).json.token as string;

    // Cookie is an ambient credential: foreign or missing Origin is refused.
    expect(
      (await api(relay, { method: "POST", path: "/api/logout", headers: { cookie, origin: "https://evil.example.com" } })).status,
    ).toBe(403);
    expect((await api(relay, { method: "POST", path: "/api/logout", headers: { cookie } })).status).toBe(403);
    // Neither refused request ran: both sessions are still alive.
    expect((await api(relay, { path: "/api/me", headers: { cookie, origin: ORIGIN } })).status).toBe(200);
    expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    // Bearer carries its own credential — any Origin is fine (desktop app).
    expect(
      (await api(relay, { method: "POST", path: "/api/logout", headers: { authorization: `Bearer ${token}`, origin: "https://whatever.invalid" } })).status,
    ).toBe(204);

    // Login itself is a mutation — cross-site login CSRF is rejected too.
    expect((await login(relay, "admin", GOOD_PASSWORD, { origin: "https://evil.example.com" })).status).toBe(403);
    // Same-origin cookie logout passes.
    expect((await api(relay, { method: "POST", path: "/api/logout", headers: { cookie, origin: ORIGIN } })).status).toBe(204);
  });

  it("routes /api ahead of the static web root", async () => {
    const web = await tempDir();
    await writeFile(join(web, "index.html"), "<html>app</html>");
    const { relay } = await startServer({ webRoot: web });
    // A POST to /api/login must reach the API, not the 405-only static handler.
    expect((await login(relay)).status).toBe(200);
    expect((await api(relay, { path: "/" })).status).toBe(200);
  });

  it("rejects oversized bodies, malformed JSON, and wrong field types", async () => {
    const { relay } = await startServer();
    expect(
      (await api(relay, { method: "POST", path: "/api/login", body: { username: "a".repeat(9000), password: "x" } })).status,
    ).toBe(413);
    expect((await api(relay, { method: "POST", path: "/api/login", body: "not json" })).status).toBe(400);
    expect((await api(relay, { method: "POST", path: "/api/login", body: { username: 5, password: "x" } })).status).toBe(400);
  });
});

describe("server login rate limiting", () => {
  it("limits login attempts per source IP", async () => {
    const { relay } = await startServer({ limits: { ipMaxAttempts: 3, ipWindowMs: 60_000 } });
    for (let index = 0; index < 3; index += 1) {
      expect((await login(relay, `user${index}`, WRONG)).status).toBe(401);
    }
    expect((await login(relay, "user4", WRONG)).status).toBe(429);
  });

  it("locks a username out after repeated failures until the window passes", async () => {
    let now = 1_800_000_000_000;
    const { relay } = await startServer({
      now: () => now,
      limits: { userMaxFailures: 2, userWindowMs: 60_000, ipMaxAttempts: 100 },
    });
    expect((await login(relay, "admin", WRONG)).status).toBe(401);
    expect((await login(relay, "admin", WRONG)).status).toBe(401);
    // Locked: even the right password is refused without running scrypt.
    expect((await login(relay)).status).toBe(429);
    now += 61_000;
    expect((await login(relay)).status).toBe(200);
  });

  it("caps the failure counter map by evicting the oldest entry", async () => {
    const { relay } = await startServer({
      limits: { userMaxFailures: 1, userWindowMs: 60_000, ipMaxAttempts: 1000, counterMaxEntries: 1 },
    });
    expect((await login(relay, "alice", WRONG)).status).toBe(401);
    expect((await login(relay, "alice", WRONG)).status).toBe(429);
    // "bob" evicts alice's counter; alice is no longer locked.
    expect((await login(relay, "bob", WRONG)).status).toBe(401);
    expect((await login(relay, "alice", WRONG)).status).toBe(401);
  });

  it("re-checks the username lock before a queued scrypt run executes", async () => {
    // A burst queues behind one slow slot; once two failures land, the queued
    // attempts must refuse instead of verifying anyway.
    const { relay } = await startServer({
      limits: { scryptConcurrency: 1, scryptQueue: 64, userMaxFailures: 2, userWindowMs: 60_000, ipMaxAttempts: 1000 },
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () => login(relay, "admin", WRONG)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });

  it("returns 429 when the scrypt queue is full", async () => {
    const { relay } = await startServer({
      limits: { scryptConcurrency: 1, scryptQueue: 0, ipMaxAttempts: 1000, userMaxFailures: 1000 },
    });
    const responses = await Promise.all([
      login(relay, "admin", WRONG),
      login(relay, "admin", WRONG),
      login(relay, "admin", WRONG),
      login(relay, "admin", WRONG),
    ]);
    const statuses = responses.map((r) => r.status);
    expect(statuses).toContain(429);
    expect(statuses).toContain(401);
  });

  it("ignores X-Forwarded-For without --trust-proxy and honors it with", async () => {
    // Without trust: spoofed XFF must not split the per-IP bucket.
    const strict = await startServer({ limits: { ipMaxAttempts: 2, ipWindowMs: 60_000 } });
    await login(strict.relay, "u1", WRONG, { "x-forwarded-for": "1.1.1.1" });
    await login(strict.relay, "u2", WRONG, { "x-forwarded-for": "2.2.2.2" });
    expect((await login(strict.relay, "u3", WRONG, { "x-forwarded-for": "3.3.3.3" })).status).toBe(429);
    await stop(strict);

    // With trust: distinct forwarded addresses get distinct buckets.
    const trusted = await startServer({ trustProxy: true, limits: { ipMaxAttempts: 2, ipWindowMs: 60_000 } });
    const https = { "x-forwarded-proto": "https" };
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      expect((await login(trusted.relay, "ux", WRONG, { ...https, "x-forwarded-for": ip })).status).toBe(401);
    }
    // One forwarded address repeatedly is still limited.
    await login(trusted.relay, "ux", WRONG, { ...https, "x-forwarded-for": "9.9.9.9" });
    await login(trusted.relay, "ux", WRONG, { ...https, "x-forwarded-for": "9.9.9.9" });
    expect((await login(trusted.relay, "ux", WRONG, { ...https, "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
    await stop(trusted);
  });

  it("requires x-forwarded-proto: https on the API and control socket when --trust-proxy is set", async () => {
    const { relay } = await startServer({ trustProxy: true });
    expect((await login(relay)).status).toBe(403);
    expect((await login(relay, "admin", GOOD_PASSWORD, { "x-forwarded-proto": "http" })).status).toBe(403);
    expect((await login(relay, "admin", GOOD_PASSWORD, { "x-forwarded-proto": "https" })).status).toBe(200);

    const refused = new WebSocket(`${relay.url}/host`);
    sockets.add(refused);
    const error = await once(refused, "error").catch((e: unknown) => e);
    expect(String(error)).toContain("403");
  });
});

describe("desktop origin and legacy mode", () => {
  const DESKTOP = "app://pinomad";

  it("answers CORS preflights only for the desktop origin", async () => {
    const { relay } = await startServer();
    const preflight = await api(relay, { method: "OPTIONS", path: "/api/login", headers: { origin: DESKTOP } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(DESKTOP);
    expect(preflight.headers["access-control-allow-methods"]).toBe("GET, POST");
    expect(preflight.headers["access-control-allow-headers"]).toBe("authorization, content-type");
    // Ambient credentials are never cross-origin.
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();

    const other = await api(relay, { method: "OPTIONS", path: "/api/login", headers: { origin: "https://evil.example.com" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns a bare token and no cookie to the desktop renderer", async () => {
    const { relay } = await startServer();
    const response = await login(relay, "admin", GOOD_PASSWORD, { origin: DESKTOP });
    expect(response.status).toBe(200);
    expect(typeof response.json.token).toBe("string");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBe(DESKTOP);

    // The token works as Bearer — including on a mutating call from that origin.
    expect(
      (
        await api(relay, {
          method: "POST",
          path: "/api/logout",
          headers: { authorization: `Bearer ${response.json.token}`, origin: DESKTOP },
        })
      ).status,
    ).toBe(204);
  });

  it("answers a JSON 404 on /api/* when accounts are off, ahead of the SPA fallback", async () => {
    const web = await tempDir();
    await writeFile(join(web, "index.html"), "<html>app</html>");
    const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, allowedHosts: ["host-id"], webRoot: web });
    relays.push(relay);
    const response = await api(relay, { path: "/api/me" });
    expect(response.status).toBe(404);
    expect(response.json.error).toBe("accounts_disabled");
  });
});

describe("relay passwd", () => {
  it("refuses to change the password while the server holds the data dir", async () => {
    const { dataDir } = await startServer();
    await expect(changePassword({ dataDir, password: NEW_PASSWORD })).rejects.toThrow(/already in use|held|running/i);
  });

  it("swaps the hash and invalidates sessions and unused join tokens", async () => {
    const started = await startServer();
    const { relay, accounts, dataDir } = started;
    const token = (await login(relay)).json.token as string;
    expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    // join-token APIs land in step 2; write rows directly to prove passwd clears only unused ones.
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO join_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)").run(
      "unused-token-hash",
      1,
      1000,
      2000,
    );
    db.prepare("INSERT INTO join_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)").run(
      "used-token-hash",
      1,
      1000,
      2000,
      1500,
    );
    db.close();

    await stop(started);
    await expect(changePassword({ dataDir, password: "too short" })).rejects.toThrow();
    await changePassword({ dataDir, password: NEW_PASSWORD });

    const second = await startServer({ dataDir, bootstrap: {} });
    expect((await login(second.relay, "admin", GOOD_PASSWORD)).status).toBe(401);
    expect((await login(second.relay, "admin", NEW_PASSWORD)).status).toBe(200);
    expect((await api(second.relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } })).status).toBe(401);

    const verify = new DatabaseSync(join(dataDir, "server.sqlite"));
    const unused = verify.prepare("SELECT COUNT(*) AS n FROM join_tokens WHERE token_hash = 'unused-token-hash'").get() as { n: number };
    const used = verify.prepare("SELECT COUNT(*) AS n FROM join_tokens WHERE token_hash = 'used-token-hash'").get() as { n: number };
    expect(unused.n).toBe(0);
    expect(used.n).toBe(1);
    verify.close();
  });
});

describe("server CLI account mode", () => {
  const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const children = new Set<ChildProcess>();
  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  /** Runs `main.ts` until the ready line or exit; resolves with the log. */
  function runMain(home: string, env: Record<string, string>): Promise<{ log: string; child: ChildProcess }> {
    const child = spawn(process.execPath, [mainPath, "--public-origin", "https://relay.example.com", "--port", "0"], {
      env: { HOME: home, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    return new Promise((resolve, reject) => {
      let log = "";
      const onData = (chunk: Buffer) => {
        log += chunk.toString();
        if (log.includes('"event":"ready"')) resolve({ log, child });
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${log}`)));
      setTimeout(() => reject(new Error(`no ready event: ${log}`)), 15_000);
    });
  }

  it("reopens the default data dir after the bootstrap env vars are gone", async () => {
    const home = await tempDir();
    // First boot: env vars create the account under ~/.pinomad-server.
    const first = await runMain(home, { PINOMAD_SERVER_USER: "admin", PINOMAD_SERVER_PASSWORD: GOOD_PASSWORD });
    expect(first.log).toContain('"accounts":true');
    first.child.kill("SIGTERM");
    await once(first.child, "exit");

    // Same command, no env vars: account mode must persist — the users already exist.
    const second = await runMain(home, {});
    expect(second.log).toContain('"accounts":true');
    second.child.kill("SIGTERM");
    await once(second.child, "exit");
  });
});

describe("host registration with accounts", () => {
  it("lets a host register when bound in the hosts table, no --allow-host needed", async () => {
    const { relay, accounts } = await startServer();
    const keys = ed25519.keygen();
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      relayHostId(keys.publicKey),
      1,
      "noise-public-key",
      "test-host",
      1000,
      1000,
    );
    db.close();
    expect(await tryRegister(relay, keys)).toBe("registered");

    // A well-signed but unbound host is still refused.
    expect(await tryRegister(relay, ed25519.keygen())).toBe(RELAY_CLOSE.hostNotAllowed);
  });
});
