import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
  type RegisterFrame,
} from "@pinomad/protocol/relay.ts";
import { openAccounts, resetPassword, type Accounts, type LoginLimits } from "../src/accounts.ts";
import { startRelay, type Relay, type RelayOptions } from "../src/relay.ts";
import { lockDataDir } from "../src/lock.ts";
import { downgradeToSchema3, removeTempDir, tempDir } from "./support.ts";

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
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

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
  readonly webRoot?: string;
  readonly now?: () => number;
  readonly limits?: LoginLimits;
  readonly lockStaleMs?: number;
  /** Relay splice limits and their clock (issue #453). */
  readonly relay?: Pick<RelayOptions, "limits" | "now">;
}): Promise<Started> {
  const dataDir = options?.dataDir ?? (await tempDir(dirs));
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
    acceptTimeoutMs: 150,
    registerTimeoutMs: 150,
    webRoot: options?.webRoot,
    accounts,
    trustProxy: options?.trustProxy ?? false,
    ...options?.relay,
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
  const register: RegisterFrame = { t: "register", hostId, signature: signRelayChallenge(keys.secretKey, { relayOrigin: ORIGIN, hostId, nonce: challenge.nonce }) };
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
    const dir = await tempDir(dirs);
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
    const dir = await tempDir(dirs);
    const first = await startServer({ dataDir: dir });
    const token = (await login(first.relay)).json.token as string;
    await stop(first);

    const second = await startServer({ dataDir: dir, bootstrap: {} });
    const me = await api(second.relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect((await login(second.relay)).status).toBe(200);
  });

  it("refuses a second process on the same data directory", async () => {
    const dir = await tempDir(dirs);
    // Same stale value on both sides — a shorter contender-side stale would
    // mistake the live lock for an abandoned one and steal it.
    await startServer({ dataDir: dir, lockStaleMs: 2000 });
    await expect(
      openAccounts({ dataDir: dir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD, lockStaleMs: 2000 }),
    ).rejects.toThrow(/already in use|held/i);
  });

  it("reports an unwritable lock location as itself, not as a running server", async () => {
    // proper-lockfile creates `<dataDir>.lock` beside the directory: a parent
    // the server can't write (a container's `/`) must not read as "in use".
    const parent = await tempDir(dirs);
    const dataDir = join(parent, "server");
    await mkdir(dataDir);
    await chmod(parent, 0o555);
    try {
      const failure = openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
      await expect(failure).rejects.toThrow(/EACCES|permission/i);
      await expect(failure).rejects.not.toThrow(/already in use/i);
    } finally {
      await chmod(parent, 0o755);
    }
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
    const web = await tempDir(dirs);
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
    const web = await tempDir(dirs);
    await writeFile(join(web, "index.html"), "<html>app</html>");
    const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, webRoot: web });
    relays.push(relay);
    const response = await api(relay, { path: "/api/me" });
    expect(response.status).toBe(404);
    expect(response.json.error).toBe("accounts_disabled");
  });
});

describe("server passwd", () => {
  it("resets the password while the server runs, signing the account out at once", async () => {
    const { relay, accounts, dataDir } = await startServer();
    const token = (await login(relay)).json.token as string;
    accounts.registerPushToken(1, "aa".repeat(32), "production");

    await resetPassword({ dataDir, password: NEW_PASSWORD });

    expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(accounts.pushTokenOwner("aa".repeat(32), "production")).toBeUndefined();
    expect((await login(relay, "admin", GOOD_PASSWORD)).status).toBe(401);
    expect((await login(relay, "admin", NEW_PASSWORD)).status).toBe(200);
  });

  it("refuses to touch a running server's database when its schema differs from this build", async () => {
    const dataDir = await tempDir(dirs);
    const accounts = await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
    await accounts.close();
    const db = new DatabaseSync(join(dataDir, "server.sqlite"));
    db.exec("PRAGMA user_version = 2");
    db.close();
    // Stands in for an older server still running after the package was upgraded.
    const release = await lockDataDir(dataDir);
    try {
      await expect(resetPassword({ dataDir, password: NEW_PASSWORD })).rejects.toThrow(/schema/i);
    } finally {
      await release();
    }
    const after = new DatabaseSync(join(dataDir, "server.sqlite"));
    expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    after.close();
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
    await expect(resetPassword({ dataDir, password: "too short" })).rejects.toThrow();
    await resetPassword({ dataDir, password: NEW_PASSWORD });

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

describe("changing the password (#450)", () => {
  const TOKEN = "bb".repeat(32);
  const change = (relay: Relay, headers: Record<string, string>, body: unknown) =>
    api(relay, { method: "POST", path: "/api/password", headers, body });

  it("changes the password, keeps the calling session and signs every other one out", async () => {
    const { relay, accounts } = await startServer();
    const current = (await login(relay)).json.token as string;
    const other = (await login(relay)).json.token as string;
    accounts.registerPushToken(1, TOKEN, "production");
    accounts.createJoinToken(1);

    const response = await change(relay, { authorization: `Bearer ${current}` }, {
      currentPassword: GOOD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(204);

    expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${current}` } })).status).toBe(200);
    expect((await api(relay, { path: "/api/me", headers: { authorization: `Bearer ${other}` } })).status).toBe(401);
    // Devices that were signed out stop receiving pushes until they sign in
    // again; the caller's own device registers again on its next start.
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBeUndefined();
    const db = new DatabaseSync(accounts.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM join_tokens WHERE used_at IS NULL").get() as { n: number }).n).toBe(0);
    db.close();
    expect((await login(relay, "admin", GOOD_PASSWORD)).status).toBe(401);
    expect((await login(relay, "admin", NEW_PASSWORD)).status).toBe(200);
  });

  it("works for the same-origin page's cookie session, which it keeps", async () => {
    const { relay } = await startServer();
    const cookie = sessionCookie(await login(relay, "admin", GOOD_PASSWORD, { origin: ORIGIN }));
    const headers = { cookie, origin: ORIGIN };
    expect((await change(relay, headers, { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(204);
    expect((await api(relay, { path: "/api/me", headers })).status).toBe(200);
    // Ambient cookie, foreign origin: refused before the body is read.
    expect((await change(relay, { cookie, origin: "https://evil.example" }, { currentPassword: NEW_PASSWORD, newPassword: GOOD_PASSWORD })).status).toBe(403);
  });

  it("refuses a wrong current password without changing anything, and locks out guessing", async () => {
    const { relay } = await startServer({ limits: { userMaxFailures: 2, ipMaxAttempts: 100 } });
    const token = (await login(relay)).json.token as string;
    const auth = { authorization: `Bearer ${token}` };
    for (let i = 0; i < 2; i += 1) {
      const response = await change(relay, auth, { currentPassword: WRONG, newPassword: NEW_PASSWORD });
      expect(response.status).toBe(403);
      expect(response.json.error).toBe("wrong_password");
    }
    // Same lock as login: a stolen session can't be used to guess the password.
    expect((await change(relay, auth, { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(429);
    // A wrong password is not a reason to drop the caller's session.
    expect((await api(relay, { path: "/api/me", headers: auth })).status).toBe(200);
  });

  // Both reads of the stored hash happen before the first await, so a write
  // made right after the call lands while the scrypt work is in flight.
  const replaceHash = (accounts: Accounts): void => {
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("UPDATE users SET password_hash = 'scrypt$reset-meanwhile' WHERE id = 1").run();
    db.close();
  };

  it("does not overwrite a password reset that lands while the current one is being checked", async () => {
    const { relay, accounts } = await startServer();
    const token = (await login(relay)).json.token as string;
    const pending = accounts.changePassword({
      userId: 1,
      username: "admin",
      keepToken: token,
      currentPassword: GOOD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    replaceHash(accounts);
    expect(await pending).toEqual({ status: "refused", reason: "wrong_password" });
    expect((await login(relay, "admin", NEW_PASSWORD)).status).toBe(401);
  });

  it("issues no session to a login whose password changed while it was being checked", async () => {
    const { accounts } = await startServer();
    const pending = accounts.login("admin", GOOD_PASSWORD, "203.0.113.9");
    replaceHash(accounts);
    expect(await pending).toEqual({ status: "invalid" });
    const db = new DatabaseSync(accounts.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("refuses a weak new password, malformed bodies and anonymous callers", async () => {
    const { relay } = await startServer();
    const token = (await login(relay)).json.token as string;
    const auth = { authorization: `Bearer ${token}` };
    const weak = await change(relay, auth, { currentPassword: GOOD_PASSWORD, newPassword: "short" });
    expect(weak.status).toBe(400);
    expect(weak.json.error).toBe("weak_password");
    expect((await change(relay, auth, { currentPassword: GOOD_PASSWORD })).status).toBe(400);
    expect((await change(relay, auth, "nope")).status).toBe(400);
    expect((await change(relay, auth, { currentPassword: "x".repeat(2000), newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await change(relay, { authorization: "Bearer nope" }, { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
    expect((await api(relay, { path: "/api/password", headers: auth })).status).toBe(405);
    expect((await login(relay)).status).toBe(200);
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
      // `close`, not `exit`: the refusal's stderr may still be draining at exit.
      child.on("close", (code) => reject(new Error(`exited ${code}: ${log}`)));
      setTimeout(() => reject(new Error(`no ready event: ${log}`)), 15_000);
    });
  }

  it("refuses a first start without the bootstrap env vars", async () => {
    const home = await tempDir(dirs);
    await expect(runMain(home, {})).rejects.toThrow(/exited 1: [\s\S]*PINOMAD_SERVER_USER and PINOMAD_SERVER_PASSWORD are required/);
  });

  it("reopens the default data dir after the bootstrap env vars are gone", async () => {
    const home = await tempDir(dirs);
    // First boot: env vars create the account under ~/.pinomad-server.
    const first = await runMain(home, { PINOMAD_SERVER_USER: "admin", PINOMAD_SERVER_PASSWORD: GOOD_PASSWORD });
    first.child.kill("SIGTERM");
    await once(first.child, "exit");

    // Same command, no env vars: the users already exist, so it starts.
    const second = await runMain(home, {});
    second.child.kill("SIGTERM");
    await once(second.child, "exit");
  });
});

describe("host registration with accounts", () => {
  it("lets a host register when bound in the hosts table", async () => {
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

describe("push token registration (ADR-0036)", () => {
  const TOKEN = "aa".repeat(32);
  const register = (relay: Relay, token: string, body: unknown, path = "/api/push-tokens") =>
    api(relay, { method: "POST", path, headers: { authorization: `Bearer ${token}` }, body });

  it("registers and removes a token for the logged-in account", async () => {
    const { relay, accounts } = await startServer();
    const token = (await login(relay)).json.token as string;
    expect((await register(relay, token, { apns: TOKEN.toUpperCase(), environment: "production" })).status).toBe(204);
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBe(1);
    expect(accounts.pushTokenOwner(TOKEN, "development")).toBeUndefined();

    expect((await register(relay, token, { apns: TOKEN, environment: "production" }, "/api/push-tokens/remove")).status).toBe(204);
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBeUndefined();
  });

  it("refuses anonymous callers and malformed tokens", async () => {
    const { relay } = await startServer();
    expect((await api(relay, { method: "POST", path: "/api/push-tokens", headers: { authorization: "Bearer nope" }, body: { apns: TOKEN, environment: "production" } })).status).toBe(401);
    const token = (await login(relay)).json.token as string;
    for (const body of [
      { apns: "not hex", environment: "production" },
      { apns: "abc", environment: "production" },
      { apns: "aa".repeat(129), environment: "production" },
      { apns: TOKEN, environment: "sandbox" },
      { apns: TOKEN },
    ]) {
      const response = await register(relay, token, body);
      expect(response.status).toBe(400);
      expect(response.json.error).toBe("invalid_request");
    }
    expect((await api(relay, { path: "/api/push-tokens", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it("removes only the caller's own registration", async () => {
    const { accounts } = await startServer();
    const db = new DatabaseSync(accounts.dbPath);
    const other = Number(
      db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('bob', 'scrypt$x', 1)").run().lastInsertRowid,
    );
    db.close();
    accounts.registerPushToken(other, TOKEN, "production");
    accounts.removePushToken(1, TOKEN, "production");
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBe(other);
  });

  it("clears the account's tokens on revoke-all", async () => {
    const { relay, accounts } = await startServer();
    const token = (await login(relay)).json.token as string;
    await register(relay, token, { apns: TOKEN, environment: "production" });
    await api(relay, { method: "POST", path: "/api/sessions/revoke-all", headers: { authorization: `Bearer ${token}` } });
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBeUndefined();
  });

  it("does not register a token for a session revoked while its body was still arriving", async () => {
    const { relay, accounts } = await startServer();
    const token = (await login(relay)).json.token as string;
    const body = JSON.stringify({ apns: TOKEN, environment: "production" });
    const half = body.length >> 1;

    // Headers and half the body go out first; the server authenticates on
    // the headers and then waits for the rest.
    let resolveStatus: (status: number) => void = () => {};
    const status = new Promise<number>((resolve) => (resolveStatus = resolve));
    const slow = httpRequest(
      {
        host: "127.0.0.1",
        port: relay.port,
        path: "/api/push-tokens",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": String(Buffer.byteLength(body)) },
      },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      },
    );
    await new Promise<void>((resolve) => slow.write(body.slice(0, half), () => resolve()));

    // Signing out everywhere lands before the body completes.
    const revoked = await api(relay, {
      method: "POST",
      path: "/api/sessions/revoke-all",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(204);

    slow.end(body.slice(half));
    expect(await status).toBe(401);
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBeUndefined();
  });

  it("treats a registration unrefreshed for 90 days as gone, and a refresh keeps it", async () => {
    let clock = 1_000;
    const { accounts } = await startServer({ now: () => clock });
    accounts.registerPushToken(1, TOKEN, "production");
    clock += 89 * DAY;
    accounts.registerPushToken(1, TOKEN, "production");
    clock += 89 * DAY;
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBe(1);
    clock += 2 * DAY;
    expect(accounts.pushTokenOwner(TOKEN, "production")).toBeUndefined();
  });

  it("keeps at most 32 tokens per account, evicting the least recently refreshed", async () => {
    let clock = 1_000;
    const { accounts } = await startServer({ now: () => clock });
    const tokens = Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, "0"));
    for (const token of tokens) {
      accounts.registerPushToken(1, token, "production");
      clock += 1;
    }
    expect(accounts.pushTokenOwner(tokens[0]!, "production")).toBeUndefined();
    expect(accounts.pushTokenOwner(tokens[1]!, "production")).toBe(1);
    expect(accounts.pushTokenOwner(tokens[32]!, "production")).toBe(1);
  });

  it("adds the push_tokens table to a schema-1 database", async () => {
    const first = await startServer();
    await stop(first);
    downgradeToSchema3(first.dataDir);
    const db = new DatabaseSync(join(first.dataDir, "server.sqlite"));
    db.exec("DROP TABLE invites; ALTER TABLE users DROP COLUMN admin; DROP TABLE push_tokens; PRAGMA user_version = 1;");
    db.close();

    const second = await startServer({ dataDir: first.dataDir, bootstrap: {} });
    second.accounts.registerPushToken(1, TOKEN, "production");
    expect(second.accounts.pushTokenOwner(TOKEN, "production")).toBe(1);
  });
});

describe("invite sign-up (#449)", () => {
  const bearer = (token: unknown): Record<string, string> => ({ authorization: `Bearer ${token as string}` });
  const adminToken = async (relay: Relay): Promise<string> => (await login(relay)).json.token as string;
  const mint = async (relay: Relay, token: string): Promise<string> => {
    const response = await api(relay, { method: "POST", path: "/api/invites", headers: bearer(token) });
    expect(response.status).toBe(200);
    return response.json.code as string;
  };
  const signUp = (relay: Relay, body: unknown, headers?: Record<string, string>) =>
    api(relay, { method: "POST", path: "/api/register", headers, body });

  it("makes the bootstrap account the admin, and only it", async () => {
    const { relay } = await startServer();
    const signedIn = await login(relay);
    expect(signedIn.json.admin).toBe(true);
    const token = signedIn.json.token as string;
    expect((await api(relay, { path: "/api/me", headers: bearer(token) })).json).toEqual({
      user: { username: "admin" },
      admin: true,
    });
    const code = await mint(relay, token);
    const bob = await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD });
    expect(bob.json.admin).toBeUndefined();
    expect((await api(relay, { path: "/api/me", headers: bearer(bob.json.token) })).json).toEqual({ user: { username: "bob" } });
    expect((await login(relay, "bob")).json.admin).toBeUndefined();
    // A regular account can neither mint nor see invites.
    expect((await api(relay, { method: "POST", path: "/api/invites", headers: bearer(bob.json.token) })).status).toBe(403);
    expect((await api(relay, { path: "/api/invites", headers: bearer(bob.json.token) })).status).toBe(403);
    expect((await api(relay, { path: "/api/invites" })).status).toBe(401);
  });

  it("signs a new user up with an invite and signs them in", async () => {
    const { relay } = await startServer();
    const code = await mint(relay, await adminToken(relay));

    // Same response styles as login: a same-origin page gets the cookie only…
    const page = await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD }, { origin: ORIGIN });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ user: { username: "bob" } });
    expect(page.json.token).toBeUndefined();
    expect((await api(relay, { path: "/api/me", headers: { cookie: sessionCookie(page), origin: ORIGIN } })).status).toBe(200);
    expect((await login(relay, "bob")).status).toBe(200);

    // …and the desktop renderer gets a bare token.
    const second = await mint(relay, await adminToken(relay));
    const desktop = await signUp(relay, { invite: second, username: "carol", password: GOOD_PASSWORD }, { origin: "app://pinomad" });
    expect(desktop.status).toBe(200);
    expect(typeof desktop.json.token).toBe("string");
    expect(desktop.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses used, unknown, revoked and expired invites", async () => {
    let clock = 1_000;
    const { relay } = await startServer({ now: () => clock });
    const token = await adminToken(relay);
    const code = await mint(relay, token);
    expect((await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD })).status).toBe(200);
    const reused = await signUp(relay, { invite: code, username: "carol", password: GOOD_PASSWORD });
    expect(reused.status).toBe(403);
    expect(reused.json.error).toBe("invalid_invite");
    expect((await signUp(relay, { invite: "made-up", username: "carol", password: GOOD_PASSWORD })).json.error).toBe("invalid_invite");

    const revoked = await mint(relay, token);
    const listed = (await api(relay, { path: "/api/invites", headers: bearer(token) })).json as unknown as { id: number; usedAt?: number }[];
    const unused = listed.find((invite) => invite.usedAt === undefined)!;
    expect((await api(relay, { method: "POST", path: "/api/invites/revoke", headers: bearer(token), body: { id: unused.id } })).status).toBe(204);
    expect((await signUp(relay, { invite: revoked, username: "carol", password: GOOD_PASSWORD })).json.error).toBe("invalid_invite");

    const late = await mint(relay, token);
    clock += 7 * DAY;
    const expired = await signUp(relay, { invite: late, username: "carol", password: GOOD_PASSWORD });
    expect(expired.status).toBe(403);
    expect(expired.json.error).toBe("invite_expired");
  });

  it("lists invites with who used them, and keeps used ones when revoked", async () => {
    const { relay } = await startServer();
    const token = await adminToken(relay);
    const code = await mint(relay, token);
    await mint(relay, token);
    await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD });
    const listed = (await api(relay, { path: "/api/invites", headers: bearer(token) })).json as unknown as Record<string, unknown>[];
    expect(listed).toHaveLength(2);
    const used = listed.find((invite) => invite.usedBy === "bob")!;
    expect(typeof used.usedAt).toBe("number");
    // The list never carries the code itself — only its hash is stored.
    expect(JSON.stringify(listed)).not.toContain(code);
    expect((await api(relay, { method: "POST", path: "/api/invites/revoke", headers: bearer(token), body: { id: used.id } })).status).toBe(404);
  });

  it("validates the username and password, and leaves the invite unspent on refusal", async () => {
    const { relay } = await startServer();
    const code = await mint(relay, await adminToken(relay));
    for (const [body, error] of [
      [{ invite: code, username: "Bob", password: GOOD_PASSWORD }, "invalid_username"],
      [{ invite: code, username: "b", password: GOOD_PASSWORD }, "invalid_username"],
      [{ invite: code, username: "bob smith", password: GOOD_PASSWORD }, "invalid_username"],
      [{ invite: code, username: "bob", password: "short" }, "weak_password"],
      [{ invite: code, username: "admin", password: GOOD_PASSWORD }, "username_taken"],
      [{ invite: code, username: "bob" }, "invalid_request"],
    ] as const) {
      const response = await signUp(relay, body);
      expect(response.json.error).toBe(error);
    }
    expect((await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD })).status).toBe(200);
  });

  it("treats usernames that differ only in case as taken", async () => {
    const { relay } = await startServer({ bootstrap: { user: "Kieran", password: GOOD_PASSWORD } });
    const token = (await login(relay, "Kieran")).json.token as string;
    const code = await mint(relay, token);
    const response = await signUp(relay, { invite: code, username: "kieran", password: GOOD_PASSWORD });
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("username_taken");
  });

  it("spends an invite once when two sign-ups race for it", async () => {
    const { relay } = await startServer();
    const code = await mint(relay, await adminToken(relay));
    const results = await Promise.all([
      signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD }),
      signUp(relay, { invite: code, username: "carol", password: GOOD_PASSWORD }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
  });

  it("shares the per-address limit with login", async () => {
    const { relay } = await startServer({ limits: { ipMaxAttempts: 2 } });
    await login(relay, "admin", WRONG);
    await signUp(relay, { invite: "made-up", username: "bob", password: GOOD_PASSWORD });
    const limited = await signUp(relay, { invite: "made-up", username: "bob", password: GOOD_PASSWORD });
    expect(limited.status).toBe(429);
  });

  it("keeps accounts apart: a new user sees none of another account's hosts", async () => {
    const { relay, accounts } = await startServer();
    const hostId = relayHostId(ed25519.keygen().publicKey);
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, 1, 'k', 'admin-host', 1, 1)").run(hostId);
    db.close();
    const code = await mint(relay, await adminToken(relay));
    const bob = (await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD })).json.token;

    expect((await api(relay, { path: "/api/hosts", headers: bearer(bob) })).json).toEqual([]);
    const pairing = await api(relay, { method: "POST", path: `/api/hosts/${hostId}/pairing`, headers: bearer(bob) });
    expect(pairing.status).toBe(404);
    expect((await api(relay, { path: "/api/hosts", headers: bearer(await adminToken(relay)) })).json).toHaveLength(1);
  });

  it("never hands a swept invite's id to a new one, so a stale revoke can't hit it", async () => {
    let clock = 1_000;
    const { relay } = await startServer({ now: () => clock });
    const token = await adminToken(relay);
    await mint(relay, token);
    const [old] = (await api(relay, { path: "/api/invites", headers: bearer(token) })).json as unknown as { id: number }[];
    clock += 8 * DAY;
    // Minting sweeps the expired invite; the new one must not reuse its id.
    const fresh = await mint(relay, token);
    const revoked = await api(relay, { method: "POST", path: "/api/invites/revoke", headers: bearer(token), body: { id: old!.id } });
    expect(revoked.status).toBe(404);
    expect((await signUp(relay, { invite: fresh, username: "bob", password: GOOD_PASSWORD })).status).toBe(200);
  });

  it("does not revoke an invite for a session revoked while its body was still arriving", async () => {
    const { relay } = await startServer();
    const token = await adminToken(relay);
    const code = await mint(relay, token);
    const [invite] = (await api(relay, { path: "/api/invites", headers: bearer(token) })).json as unknown as { id: number }[];
    const body = JSON.stringify({ id: invite!.id });

    let resolveStatus: (status: number) => void = () => {};
    const status = new Promise<number>((resolve) => (resolveStatus = resolve));
    const slow = httpRequest(
      {
        host: "127.0.0.1",
        port: relay.port,
        path: "/api/invites/revoke",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": String(Buffer.byteLength(body)) },
      },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      },
    );
    await new Promise<void>((resolve) => slow.write(body.slice(0, 2), () => resolve()));
    expect((await api(relay, { method: "POST", path: "/api/sessions/revoke-all", headers: bearer(token) })).status).toBe(204);
    slow.end(body.slice(2));
    expect(await status).toBe(401);
    expect((await signUp(relay, { invite: code, username: "bob", password: GOOD_PASSWORD })).status).toBe(200);
  });

  it("marks the first user admin when upgrading a schema-2 database", async () => {
    const first = await startServer();
    await stop(first);
    downgradeToSchema3(first.dataDir);
    const db = new DatabaseSync(join(first.dataDir, "server.sqlite"));
    db.exec("DROP TABLE invites; ALTER TABLE users DROP COLUMN admin; PRAGMA user_version = 2;");
    db.close();

    const second = await startServer({ dataDir: first.dataDir, bootstrap: {} });
    const token = await adminToken(second.relay);
    expect((await api(second.relay, { path: "/api/me", headers: bearer(token) })).json.admin).toBe(true);
    await mint(second.relay, token);
  });
});

describe("deleting an account (#451)", () => {
  const bearer = (token: unknown): Record<string, string> => ({ authorization: `Bearer ${token as string}` });
  const remove = (relay: Relay, headers: Record<string, string>, body: unknown) =>
    api(relay, { method: "POST", path: "/api/me/delete", headers, body });

  /** Signs up `username` (bob by default) through an admin invite; resolves to its bearer token and the invite code. */
  async function signUpBob(relay: Relay, username = "bob"): Promise<{ readonly token: string; readonly invite: string }> {
    const admin = (await login(relay)).json.token as string;
    const invite = (await api(relay, { method: "POST", path: "/api/invites", headers: bearer(admin) })).json.code as string;
    const response = await api(relay, {
      method: "POST",
      path: "/api/register",
      body: { invite, username, password: GOOD_PASSWORD },
    });
    return { token: response.json.token as string, invite };
  }

  /** A host bound to `userId` whose control connection stays open; `closed` resolves to its close code. */
  async function liveHost(
    relay: Relay,
    accounts: Accounts,
    userId: number,
  ): Promise<{ readonly keys: KeyPair; readonly socket: WebSocket; readonly closed: Promise<number> }> {
    const keys = ed25519.keygen();
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at) VALUES (?, ?, 'k', 'h', 1, 1)").run(
      relayHostId(keys.publicKey),
      userId,
    );
    db.close();
    const socket = new WebSocket(`${relay.url}/host`);
    sockets.add(socket);
    const closed = once(socket, "close").then(([code]) => code as number);
    const challengeP = once(socket, "message");
    await once(socket, "open");
    const challenge = decodeRelayToHost(asText((await challengeP)[0]));
    if (challenge.t !== "challenge") throw new Error("expected challenge");
    const hostId = relayHostId(keys.publicKey);
    socket.send(encodeRelayFrame({ t: "register", hostId, signature: signRelayChallenge(keys.secretKey, { relayOrigin: ORIGIN, hostId, nonce: challenge.nonce }) }));
    const [data] = await once(socket, "message");
    expect(decodeRelayToHost(asText(data)).t).toBe("registered");
    return { keys, socket, closed };
  }

  /** A device spliced to `host` and authenticated by a first host frame (issue #453). */
  async function splicedDevice(
    relay: Relay,
    host: { readonly keys: KeyPair; readonly socket: WebSocket },
  ): Promise<{ readonly device: WebSocket; readonly accept: WebSocket }> {
    const incomingP = once(host.socket, "message");
    const device = new WebSocket(`${relay.url}/c/${relayHostId(host.keys.publicKey)}`);
    sockets.add(device);
    await once(device, "open");
    const incoming = decodeRelayToHost(asText((await incomingP)[0]));
    if (incoming.t !== "incoming") throw new Error("expected incoming");
    const accept = new WebSocket(`${relay.url}/accept/${incoming.connId}`);
    sockets.add(accept);
    await once(accept, "open");
    const answered = once(device, "message");
    accept.send(Buffer.from([2]));
    await answered;
    return { device, accept };
  }

  const closeCode = (socket: WebSocket): Promise<number> => once(socket, "close").then(([code]) => code as number);

  it("closes the account's splices and forgets its traffic budget, so a new account reusing its id starts fresh", async () => {
    const { relay, accounts } = await startServer({ relay: { limits: { accountBytesPerSecond: 1, accountBurstBytes: 1000 }, now: () => 0 } });
    const bob = await signUpBob(relay);
    const host = await liveHost(relay, accounts, 2);
    const drained = await splicedDevice(relay, host);
    const survivor = await splicedDevice(relay, host);
    const drainedClosed = closeCode(drained.device);
    drained.device.send(new Uint8Array(2000));
    expect(await drainedClosed).toBe(RELAY_CLOSE.trafficLimit);

    const survivorClosed = closeCode(survivor.device);
    expect((await remove(relay, bearer(bob.token), { password: GOOD_PASSWORD })).status).toBe(204);
    expect(await survivorClosed).toBe(RELAY_CLOSE.hostNotAllowed);

    // users.id has no AUTOINCREMENT: carol gets bob's id back, but not his debt.
    const carol = await signUpBob(relay, "carol");
    expect(accounts.authenticate(carol.token)?.userId).toBe(2);
    const fresh = await splicedDevice(relay, await liveHost(relay, accounts, 2));
    const forwarded = once(fresh.accept, "message");
    fresh.device.send(new Uint8Array(900));
    await forwarded;
  });

  it("deletes the account and everything under it, and disconnects its hosts at once", async () => {
    const { relay, accounts } = await startServer();
    const bob = await signUpBob(relay);
    const host = await liveHost(relay, accounts, 2);
    accounts.registerPushToken(2, "aa".repeat(32), "production");

    const response = await remove(relay, bearer(bob.token), { password: GOOD_PASSWORD });
    expect(response.status).toBe(204);

    expect(await host.closed).toBe(RELAY_CLOSE.hostNotAllowed);
    expect(await tryRegister(relay, host.keys)).toBe(RELAY_CLOSE.hostNotAllowed);
    expect((await api(relay, { path: "/api/me", headers: bearer(bob.token) })).status).toBe(401);
    expect((await login(relay, "bob")).status).toBe(401);
    expect(accounts.pushTokenOwner("aa".repeat(32), "production")).toBeUndefined();
    // The invite stays used, with nobody behind it; the name is free again.
    const invites = (await api(relay, { path: "/api/invites", headers: bearer((await login(relay)).json.token) })).json as unknown as {
      usedAt?: number;
      usedBy?: string;
    }[];
    expect(invites).toHaveLength(1);
    expect(invites[0]!.usedAt).toBeTypeOf("number");
    expect(invites[0]!.usedBy).toBeUndefined();
  });

  it("clears the same-origin page's cookie", async () => {
    const { relay } = await startServer();
    await signUpBob(relay);
    const cookie = sessionCookie(await login(relay, "bob", GOOD_PASSWORD, { origin: ORIGIN }));
    const response = await remove(relay, { cookie, origin: ORIGIN }, { password: GOOD_PASSWORD });
    expect(response.status).toBe(204);
    expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("refuses a wrong password without deleting anything, under the login lockout", async () => {
    const { relay } = await startServer({ limits: { userMaxFailures: 2, ipMaxAttempts: 100 } });
    const bob = await signUpBob(relay);
    for (let i = 0; i < 2; i += 1) {
      const response = await remove(relay, bearer(bob.token), { password: WRONG });
      expect(response.status).toBe(403);
      expect(response.json.error).toBe("wrong_password");
    }
    expect((await remove(relay, bearer(bob.token), { password: GOOD_PASSWORD })).status).toBe(429);
    expect((await api(relay, { path: "/api/me", headers: bearer(bob.token) })).status).toBe(200);
  });

  it("does not delete an account whose password changed while it was being checked", async () => {
    const { relay, accounts } = await startServer();
    const bob = await signUpBob(relay);
    const pending = accounts.deleteAccount({ userId: 2, username: "bob", password: GOOD_PASSWORD });
    const db = new DatabaseSync(accounts.dbPath);
    db.prepare("UPDATE users SET password_hash = 'scrypt$reset-meanwhile' WHERE id = 2").run();
    db.close();
    expect(await pending).toEqual({ status: "refused", reason: "wrong_password" });
    expect(accounts.authenticate(bob.token)).toBeDefined();
  });

  it("keeps the server's admin account, which alone mints invites", async () => {
    const { relay } = await startServer();
    const admin = (await login(relay)).json.token as string;
    const response = await remove(relay, bearer(admin), { password: GOOD_PASSWORD });
    expect(response.status).toBe(403);
    expect(response.json.error).toBe("admin_account");
    expect((await api(relay, { path: "/api/me", headers: bearer(admin) })).status).toBe(200);
  });

  it("refuses malformed bodies and anonymous callers", async () => {
    const { relay } = await startServer();
    const bob = await signUpBob(relay);
    expect((await remove(relay, bearer(bob.token), {})).status).toBe(400);
    expect((await remove(relay, bearer(bob.token), { password: "x".repeat(2000) })).status).toBe(400);
    expect((await remove(relay, bearer("nope"), { password: GOOD_PASSWORD })).status).toBe(401);
    expect((await api(relay, { path: "/api/me/delete", headers: bearer(bob.token) })).status).toBe(405);
  });
});
