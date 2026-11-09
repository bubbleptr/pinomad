// Host links (#495): an RFC 8628-shaped device-code flow in front of the
// one-time join token (ADR-0022 §3). The host starts a request anonymously,
// a signed-in user confirms the short code, and the host's poll collects a
// join token bound to the hostId it announced.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  addUser,
  formatUserCode,
  normalizeUserCode,
  openAccounts,
  USER_CODE_ALPHABET,
  type Accounts,
  type HostLinkLimits,
} from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { downgradeToSchema5, removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const MINUTE = 60_000;
const HOST_ID = "h".repeat(43);
const OTHER_HOST_ID = "o".repeat(43);

const dirs: string[] = [];
const relays: Relay[] = [];
const opened: Accounts[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const accounts of opened.splice(0)) await accounts.close().catch(() => {});
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

/** A settable clock: tests move time instead of waiting. */
const clock = (start = 1_800_000_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
};

async function open(options?: { readonly dataDir?: string; readonly now?: () => number; readonly hostLinkLimits?: HostLinkLimits }) {
  const dataDir = options?.dataDir ?? (await tempDir(dirs));
  const accounts = await openAccounts({
    dataDir,
    bootstrapUser: "admin",
    bootstrapPassword: GOOD_PASSWORD,
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.hostLinkLimits === undefined ? {} : { hostLinkLimits: options.hostLinkLimits }),
  });
  opened.push(accounts);
  return { accounts, dataDir };
}

const start = (accounts: Accounts, overrides?: { hostId?: string; ip?: string; name?: string; os?: string }) =>
  accounts.startHostLink({
    hostId: overrides?.hostId ?? HOST_ID,
    name: overrides?.name ?? "omarchy",
    os: overrides?.os ?? "Linux (x64)",
    ip: overrides?.ip ?? "203.0.113.7",
  });

const started = async (accounts: Accounts, overrides?: Parameters<typeof start>[1]) => {
  const result = await start(accounts, overrides);
  if (result.status !== "ok" || result.mode !== "code") throw new Error(`start refused: ${result.status}`);
  return result;
};

const row = (accounts: Accounts): Record<string, unknown> | undefined => {
  const db = new DatabaseSync(accounts.dbPath);
  try {
    return db.prepare("SELECT * FROM host_link_requests").get() as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
};

const rowCount = (accounts: Accounts): number => {
  const db = new DatabaseSync(accounts.dbPath);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM host_link_requests").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("user codes", () => {
  it("uses the 20 consonants with no lookalikes", () => {
    expect(USER_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
  });

  it("reads input case-insensitively and ignores dashes and spaces", () => {
    expect(normalizeUserCode("wdjb-mjht")).toBe("WDJBMJHT");
    expect(normalizeUserCode(" WDJB MJHT ")).toBe("WDJBMJHT");
    expect(normalizeUserCode("wD-jB-mJ-hT")).toBe("WDJBMJHT");
  });

  it("refuses codes of the wrong length or outside the alphabet", () => {
    expect(normalizeUserCode("WDJB-MJH")).toBeUndefined();
    expect(normalizeUserCode("WDJB-MJHTX")).toBeUndefined();
    // Vowels and digits are not in the alphabet.
    expect(normalizeUserCode("WDJB-MJHA")).toBeUndefined();
    expect(normalizeUserCode("WDJB-MJH1")).toBeUndefined();
    expect(normalizeUserCode("")).toBeUndefined();
  });

  it("displays as XXXX-XXXX", () => {
    expect(formatUserCode("WDJBMJHT")).toBe("WDJB-MJHT");
  });

  it("mints codes in the display format, from the alphabet, and a long device code", async () => {
    const { accounts } = await open();
    const result = await started(accounts);
    expect(result.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    // ≥ 32 random bytes, base64url.
    expect(result.deviceCode).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(result.interval).toBe(5);
  });

  it("stores neither code in the clear", async () => {
    const { accounts } = await open();
    const result = await started(accounts);
    const stored = JSON.stringify(row(accounts));
    expect(stored).not.toContain(result.deviceCode);
    expect(stored).not.toContain(normalizeUserCode(result.userCode)!);
  });
});

describe("the request's life", () => {
  it("expires ten minutes after start, like a join token", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    const result = await started(accounts);
    expect(result.expiresAt).toBe(time.now() + 10 * MINUTE);
    time.advance(10 * MINUTE);
    expect(accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "203.0.113.7" })).toEqual({ status: "not_found" });
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "expired" });
  });

  it("answers authorization_pending until confirmed, then hands out one join token bound to the hostId", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    const result = await started(accounts);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "pending" });

    const lookup = accounts.lookupHostLink({ userId: 1, userCode: result.userCode.toLowerCase(), ip: "198.51.100.1" });
    expect(lookup).toEqual({
      status: "ok",
      request: { hostId: HOST_ID, name: "omarchy", os: "Linux (x64)", sourceIp: "203.0.113.7", ipDiffers: true, expiresAt: result.expiresAt },
    });
    expect(accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" })).toEqual({ status: "ok" });

    time.advance(5_000);
    const poll = accounts.pollHostLink(result.deviceCode);
    expect(poll.status).toBe("confirmed");
    if (poll.status !== "confirmed") throw new Error("unreachable");
    // The request is consumed: the next poll finds nothing.
    time.advance(5_000);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "expired" });

    // A normal join token, spendable once — but only by the host the user saw.
    expect(accounts.joinHost({ token: poll.token, hostId: OTHER_HOST_ID, noisePublicKey: "k" })).toEqual({
      status: "refused",
      reason: "invalid_token",
    });
    expect(accounts.joinHost({ token: poll.token, hostId: HOST_ID, noisePublicKey: "k", name: "omarchy" })).toEqual({
      status: "joined",
      username: "admin",
    });
    expect(accounts.joinHost({ token: poll.token, hostId: HOST_ID, noisePublicKey: "k" })).toEqual({
      status: "refused",
      reason: "invalid_token",
    });
  });

  it("says when the confirming IP matches the host's", async () => {
    const { accounts } = await open();
    const result = await started(accounts, { ip: "203.0.113.7" });
    const lookup = accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "203.0.113.7" });
    expect(lookup.status === "ok" && lookup.request.ipDiffers).toBe(false);
  });

  it("answers access_denied once after a deny, then expired_token", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    const result = await started(accounts);
    expect(accounts.denyHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" })).toEqual({ status: "ok" });
    // Denied is final: it can't be confirmed afterwards.
    expect(accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" })).toEqual({ status: "not_found" });
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "denied" });
    time.advance(5_000);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "expired" });
  });

  it("won't confirm a code twice", async () => {
    const { accounts } = await open();
    const result = await started(accounts);
    expect(accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" }).status).toBe("ok");
    expect(accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" })).toEqual({ status: "not_found" });
    expect(accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" })).toEqual({ status: "not_found" });
  });

  it("treats an unknown device code as expired", async () => {
    const { accounts } = await open();
    expect(accounts.pollHostLink("not-a-device-code")).toEqual({ status: "expired" });
  });

  it("answers slow_down to a host polling faster than the interval, and adds 5 s to it", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    const result = await started(accounts);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "pending" });
    time.advance(1_000);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "slow_down", interval: 10 });
    // The old interval is now too fast as well.
    time.advance(5_000);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "slow_down", interval: 15 });
    time.advance(15_000);
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "pending" });
  });

  it("goes away with a password change, which leaves nothing spendable behind", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    const login = await accounts.login("admin", GOOD_PASSWORD, "127.0.0.1");
    if (login.status !== "ok") throw new Error("login failed");
    const result = await started(accounts);
    accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "127.0.0.1" });
    expect(
      (await accounts.changePassword({
        userId: 1,
        keepToken: login.token,
        currentPassword: GOOD_PASSWORD,
        newPassword: "a different long password",
      })).status,
    ).toBe("ok");
    expect(accounts.pollHostLink(result.deviceCode)).toEqual({ status: "expired" });
  });
});

describe("personal data", () => {
  it("drops the host name, OS and source IP when the request is confirmed", async () => {
    const { accounts } = await open();
    const result = await started(accounts);
    expect(row(accounts)).toMatchObject({ host_name: "omarchy", host_os: "Linux (x64)", source_ip: "203.0.113.7" });
    accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" });
    expect(row(accounts)).toMatchObject({ host_name: null, host_os: null, source_ip: null });
  });

  it("drops them when the request is denied", async () => {
    const { accounts } = await open();
    const result = await started(accounts);
    accounts.denyHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" });
    expect(row(accounts)).toMatchObject({ host_name: null, host_os: null, source_ip: null });
  });

  it("sweeps expired requests with the join tokens", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    await started(accounts);
    time.advance(10 * MINUTE);
    expect(rowCount(accounts)).toBe(1);
    accounts.createJoinToken(1);
    expect(rowCount(accounts)).toBe(0);
  });

  it("sweeps them on the periodic sweep, with nobody touching the request", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    await started(accounts);
    time.advance(10 * MINUTE - 1);
    accounts.sweepExpired();
    expect(rowCount(accounts)).toBe(1);
    time.advance(1);
    accounts.sweepExpired();
    expect(rowCount(accounts)).toBe(0);
  });

  it("goes with the account that confirmed it", async () => {
    const { accounts, dataDir } = await open();
    await addUser({ dataDir, email: "bob@example.com", password: GOOD_PASSWORD });
    const result = await started(accounts);
    accounts.confirmHostLink({ userId: 2, userCode: result.userCode, ip: "127.0.0.1" });
    const bob = await accounts.login("bob@example.com", GOOD_PASSWORD, "127.0.0.1");
    if (bob.status !== "ok") throw new Error("login failed");
    expect((await accounts.deleteAccount({ userId: 2, keepToken: bob.token, password: GOOD_PASSWORD })).status).toBe("ok");
    expect(rowCount(accounts)).toBe(0);
  });
});

describe("limits", () => {
  it("lets one IP start 10 requests per 10 minutes", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    for (let i = 0; i < 10; i++) expect((await start(accounts, { ip: "203.0.113.7" })).status).toBe("ok");
    expect((await start(accounts, { ip: "203.0.113.7" })).status).toBe("limited");
    expect((await start(accounts, { ip: "203.0.113.8" })).status).toBe("ok");
    time.advance(10 * MINUTE);
    expect((await start(accounts, { ip: "203.0.113.7" })).status).toBe("ok");
  });

  it("refuses new requests once the global number pending is reached", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now, hostLinkLimits: { maxPending: 3 } });
    for (let i = 0; i < 3; i++) expect((await start(accounts, { ip: `203.0.113.${i}` })).status).toBe("ok");
    expect((await start(accounts, { ip: "203.0.113.99" })).status).toBe("busy");
    // Expired ones stop counting.
    time.advance(10 * MINUTE);
    expect((await start(accounts, { ip: "203.0.113.99" })).status).toBe("ok");
  });

  it("locks an account out after 10 wrong codes in 15 minutes, across lookup, confirm and deny", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now });
    const result = await started(accounts);
    for (let i = 0; i < 10; i++) {
      const ip = `198.51.100.${i}`;
      const attempt = [accounts.lookupHostLink, accounts.confirmHostLink, accounts.denyHostLink][i % 3]!;
      expect(attempt({ userId: 1, userCode: "BBBB-BBBB", ip }).status).toBe("not_found");
    }
    // Locked even with the right code, from a fresh IP.
    expect(accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.200" })).toEqual({ status: "limited" });
    expect(accounts.confirmHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.200" })).toEqual({ status: "limited" });
    time.advance(15 * MINUTE);
    const later = await started(accounts);
    expect(accounts.lookupHostLink({ userId: 1, userCode: later.userCode, ip: "198.51.100.200" }).status).toBe("ok");
  });

  it("locks an IP out after 30 wrong codes in 15 minutes, whichever accounts they came from", async () => {
    const time = clock();
    const { accounts } = await open({ now: time.now, hostLinkLimits: { userMaxFailures: 1000 } });
    const result = await started(accounts);
    for (let i = 0; i < 30; i++) {
      expect(accounts.lookupHostLink({ userId: 1 + (i % 3), userCode: "BBBB-BBBB", ip: "198.51.100.1" }).status).toBe("not_found");
    }
    expect(accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" })).toEqual({ status: "limited" });
    expect(accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.2" }).status).toBe("ok");
    time.advance(15 * MINUTE);
    const later = await started(accounts);
    expect(accounts.lookupHostLink({ userId: 1, userCode: later.userCode, ip: "198.51.100.1" }).status).toBe("ok");
  });

  it("counts a malformed code as a wrong one", async () => {
    const { accounts } = await open({ hostLinkLimits: { userMaxFailures: 2 } });
    const result = await started(accounts);
    expect(accounts.lookupHostLink({ userId: 1, userCode: "nope", ip: "198.51.100.1" }).status).toBe("not_found");
    expect(accounts.lookupHostLink({ userId: 1, userCode: "AAAA-AAAA", ip: "198.51.100.1" }).status).toBe("not_found");
    expect(accounts.lookupHostLink({ userId: 1, userCode: result.userCode, ip: "198.51.100.1" }).status).toBe("limited");
  });
});

describe("schema 6", () => {
  it("adds the host-link table and the join-token host binding to a schema-5 database", async () => {
    const first = await open();
    const token = first.accounts.createJoinToken(1);
    await first.accounts.close();
    opened.splice(opened.indexOf(first.accounts), 1);
    downgradeToSchema5(first.dataDir);

    const second = await open({ dataDir: first.dataDir });
    const db = new DatabaseSync(second.accounts.dbPath);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(6);
    db.close();
    // A token minted before the upgrade is bound to no host and still spends.
    expect(second.accounts.joinHost({ token: token.token, hostId: HOST_ID, noisePublicKey: "k" }).status).toBe("joined");
    const result = await started(second.accounts);
    expect(second.accounts.pollHostLink(result.deviceCode)).toEqual({ status: "pending" });
  });
});

// ─── HTTP ───────────────────────────────────────────────────────────────────

interface ApiResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

function api(
  relay: Relay,
  options: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: unknown },
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: relay.port, path: options.path, method: options.method ?? "POST", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          } catch {
            // Empty bodies (204) read as {}.
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    request.end();
  });
}

async function serve(options?: { readonly now?: () => number; readonly trustProxy?: boolean }) {
  const { accounts } = await open(options?.now === undefined ? undefined : { now: options.now });
  opened.splice(opened.indexOf(accounts), 1);
  const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, accounts, trustProxy: options?.trustProxy ?? false });
  relays.push(relay);
  return { relay, accounts };
}

const session = async (relay: Relay): Promise<string> =>
  (await api(relay, { path: "/api/login", body: { username: "admin", password: GOOD_PASSWORD } })).json.token as string;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const startBody = { hostId: HOST_ID, name: "omarchy", os: "Linux (x64)" };

describe("POST /api/host-link/*", () => {
  it("runs the whole flow: start, pending, lookup, confirm, token", async () => {
    const time = clock();
    const { relay } = await serve({ now: time.now });
    // The host CLI is a native caller: no Origin, no session.
    const startResponse = await api(relay, { path: "/api/host-link/start", body: startBody });
    expect(startResponse.status).toBe(200);
    const { deviceCode, userCode, verifyUrl, interval, expiresAt } = startResponse.json;
    expect(verifyUrl).toBe(`${ORIGIN}/host-link`);
    expect(interval).toBe(5);
    expect(expiresAt).toBe(time.now() + 10 * MINUTE);

    expect(await api(relay, { path: "/api/host-link/poll", body: { deviceCode } })).toEqual({
      status: 400,
      json: { error: "authorization_pending" },
    });

    const token = await session(relay);
    const lookup = await api(relay, { path: "/api/host-link/lookup", headers: bearer(token), body: { userCode } });
    expect(lookup).toEqual({
      status: 200,
      json: { hostId: HOST_ID, name: "omarchy", os: "Linux (x64)", sourceIp: "127.0.0.1", ipDiffers: false, expiresAt },
    });
    expect((await api(relay, { path: "/api/host-link/confirm", headers: bearer(token), body: { userCode } })).status).toBe(204);

    time.advance(5_000);
    const poll = await api(relay, { path: "/api/host-link/poll", body: { deviceCode } });
    expect(poll.status).toBe(200);
    expect(poll.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(poll.json.expiresAt).toBeTypeOf("number");
    time.advance(5_000);
    expect(await api(relay, { path: "/api/host-link/poll", body: { deviceCode } })).toEqual({
      status: 400,
      json: { error: "expired_token" },
    });
  });

  it("answers access_denied after a deny", async () => {
    const { relay } = await serve();
    const { deviceCode, userCode } = (await api(relay, { path: "/api/host-link/start", body: startBody })).json;
    const token = await session(relay);
    expect((await api(relay, { path: "/api/host-link/deny", headers: bearer(token), body: { userCode } })).status).toBe(204);
    expect(await api(relay, { path: "/api/host-link/poll", body: { deviceCode } })).toEqual({ status: 400, json: { error: "access_denied" } });
  });

  it("answers slow_down with the new interval", async () => {
    const { relay } = await serve();
    const { deviceCode } = (await api(relay, { path: "/api/host-link/start", body: startBody })).json;
    await api(relay, { path: "/api/host-link/poll", body: { deviceCode } });
    expect(await api(relay, { path: "/api/host-link/poll", body: { deviceCode } })).toEqual({
      status: 400,
      json: { error: "slow_down", interval: 10 },
    });
  });

  it("needs a session to look up, confirm or deny", async () => {
    const { relay } = await serve();
    for (const path of ["/api/host-link/lookup", "/api/host-link/confirm", "/api/host-link/deny"]) {
      expect(await api(relay, { path, headers: { origin: ORIGIN }, body: { userCode: "BBBB-BBBB" } })).toEqual({
        status: 401,
        json: { error: "unauthenticated" },
      });
    }
  });

  it("checks the Origin on the cookie path, like every other mutating call", async () => {
    const { relay } = await serve();
    expect(
      await api(relay, { path: "/api/host-link/confirm", headers: { origin: "https://evil.example" }, body: { userCode: "BBBB-BBBB" } }),
    ).toEqual({ status: 403, json: { error: "origin_mismatch" } });
    // start/poll are only exempt for Origin-less native callers.
    expect(await api(relay, { path: "/api/host-link/start", headers: { origin: "https://evil.example" }, body: startBody })).toEqual({
      status: 403,
      json: { error: "origin_mismatch" },
    });
  });

  it("answers a wrong code with 404 and a locked-out caller with 429", async () => {
    const { relay } = await serve();
    const token = await session(relay);
    for (let i = 0; i < 10; i++) {
      expect(await api(relay, { path: "/api/host-link/lookup", headers: bearer(token), body: { userCode: "BBBB-BBBB" } })).toEqual({
        status: 404,
        json: { error: "not_found" },
      });
    }
    expect(await api(relay, { path: "/api/host-link/lookup", headers: bearer(token), body: { userCode: "BBBB-BBBB" } })).toEqual({
      status: 429,
      json: { error: "rate_limited" },
    });
  });

  it("rate-limits start per IP with 429, keyed on X-Forwarded-For behind a trusted proxy", async () => {
    const { relay } = await serve({ trustProxy: true });
    const via = (ip: string) => ({ "x-forwarded-proto": "https", "x-forwarded-for": `${ip}, 10.0.0.1` });
    for (let i = 0; i < 10; i++) {
      expect((await api(relay, { path: "/api/host-link/start", headers: via("203.0.113.7"), body: startBody })).status).toBe(200);
    }
    expect(await api(relay, { path: "/api/host-link/start", headers: via("203.0.113.7"), body: startBody })).toEqual({
      status: 429,
      json: { error: "rate_limited" },
    });
    const other = await api(relay, { path: "/api/host-link/start", headers: via("203.0.113.8"), body: startBody });
    expect(other.status).toBe(200);
    const login = await api(relay, {
      path: "/api/login",
      headers: via("198.51.100.1"),
      body: { username: "admin", password: GOOD_PASSWORD },
    });
    const lookup = await api(relay, {
      path: "/api/host-link/lookup",
      headers: { ...via("198.51.100.1"), ...bearer(login.json.token as string) },
      body: { userCode: other.json.userCode },
    });
    expect(lookup.json).toMatchObject({ sourceIp: "203.0.113.8", ipDiffers: true });
  });

  it("refuses malformed start bodies", async () => {
    const { relay } = await serve();
    for (const body of [{}, { ...startBody, hostId: "short" }, { ...startBody, name: 4 }, { ...startBody, os: null }, "[]"]) {
      expect(await api(relay, { path: "/api/host-link/start", body })).toEqual({ status: 400, json: { error: "invalid_request" } });
    }
  });

  it("refuses GET with 405", async () => {
    const { relay } = await serve();
    expect((await api(relay, { method: "GET", path: "/api/host-link/start" })).status).toBe(405);
  });
});

// ─── Loopback (#513) ────────────────────────────────────────────────────────
// RFC 8252: a host that can open a browser on its own screen asks for a
// redirect to its loopback listener instead of a short code; PKCE binds the
// code it receives there to the verifier only it holds.

const challengeFor = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

const REDIRECT = "http://127.0.0.1:54321/callback";

describe("loopback host links (#513)", () => {
  const loopbackStart = (relay: Relay, extra?: Record<string, unknown>) => {
    const { verifier, challenge } = pkce();
    return api(relay, {
      path: "/api/host-link/start",
      body: { ...startBody, redirectUri: REDIRECT, codeChallenge: challenge, state: "st4te", ...extra },
    }).then((response) => ({ response, verifier }));
  };

  /** The browser's half: look the request up and confirm it as the signed-in user. */
  const confirmed = async (relay: Relay) => {
    const { response, verifier } = await loopbackStart(relay);
    expect(response.status).toBe(200);
    const requestId = response.json.requestId as string;
    const token = await session(relay);
    const answer = await api(relay, { path: "/api/host-link/confirm", headers: bearer(token), body: { requestId } });
    expect(answer.status).toBe(200);
    const redirect = new URL(answer.json.redirect as string);
    return { requestId, verifier, redirect, code: redirect.searchParams.get("code")!, token };
  };

  const exchange = (relay: Relay, code: string, codeVerifier: string) =>
    api(relay, { path: "/api/host-link/token", body: { code, codeVerifier } });

  it("starts without a short code: a request id in the confirm URL, nothing to poll", async () => {
    const time = clock();
    const { relay } = await serve({ now: time.now });
    const { response } = await loopbackStart(relay);
    expect(response.status).toBe(200);
    const { requestId, verifyUrl, expiresAt } = response.json;
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyUrl).toBe(`${ORIGIN}/host-link?request=${requestId as string}`);
    expect(expiresAt).toBe(time.now() + 10 * MINUTE);
    // No code to type, and no device code: a poll could only bypass the loopback.
    expect(response.json).not.toHaveProperty("userCode");
    expect(response.json).not.toHaveProperty("deviceCode");
  });

  it("looks the request up by its id and shows the same details as a typed code", async () => {
    const { relay } = await serve();
    const { response } = await loopbackStart(relay);
    const token = await session(relay);
    const lookup = await api(relay, {
      path: "/api/host-link/lookup",
      headers: bearer(token),
      body: { requestId: response.json.requestId },
    });
    expect(lookup).toEqual({
      status: 200,
      json: {
        hostId: HOST_ID,
        name: "omarchy",
        os: "Linux (x64)",
        sourceIp: "127.0.0.1",
        ipDiffers: false,
        expiresAt: response.json.expiresAt,
      },
    });
  });

  it("confirms by redirecting to the host's loopback with a code and its state, which PKCE trades once for a join token", async () => {
    const { relay, accounts } = await serve();
    const { verifier, redirect, code } = await confirmed(relay);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("st4te");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const traded = await exchange(relay, code, verifier);
    expect(traded.status).toBe(200);
    expect(traded.json.expiresAt).toBeTypeOf("number");
    // The token joins only the host that asked.
    const joinToken = traded.json.token as string;
    expect(accounts.joinHost({ token: joinToken, hostId: OTHER_HOST_ID, noisePublicKey: "k" })).toEqual({
      status: "refused",
      reason: "invalid_token",
    });
    expect(accounts.joinHost({ token: joinToken, hostId: HOST_ID, noisePublicKey: "k" }).status).toBe("joined");
    // One trade per code.
    expect(await exchange(relay, code, verifier)).toEqual({ status: 400, json: { error: "invalid_grant" } });
  });

  it("burns the code on a wrong verifier, so the right one can't follow", async () => {
    const { relay } = await serve();
    const { verifier, code } = await confirmed(relay);
    expect(await exchange(relay, code, pkce().verifier)).toEqual({ status: 400, json: { error: "invalid_grant" } });
    expect(await exchange(relay, code, verifier)).toEqual({ status: 400, json: { error: "invalid_grant" } });
  });

  it("lets a code live two minutes", async () => {
    const time = clock();
    const { relay } = await serve({ now: time.now });
    const { verifier, code } = await confirmed(relay);
    time.advance(2 * MINUTE + 1);
    expect(await exchange(relay, code, verifier)).toEqual({ status: 400, json: { error: "invalid_grant" } });
  });

  it("denies by redirecting with access_denied and the state", async () => {
    const { relay } = await serve();
    const { response } = await loopbackStart(relay);
    const token = await session(relay);
    const answer = await api(relay, {
      path: "/api/host-link/deny",
      headers: bearer(token),
      body: { requestId: response.json.requestId },
    });
    expect(answer.status).toBe(200);
    const redirect = new URL(answer.json.redirect as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("st4te");
    expect(redirect.searchParams.has("code")).toBe(false);
  });

  it("answers an unknown request id with 404 without counting it toward the code lockout", async () => {
    const { relay } = await serve();
    const token = await session(relay);
    for (let i = 0; i < 12; i++) {
      expect(
        await api(relay, { path: "/api/host-link/lookup", headers: bearer(token), body: { requestId: "x".repeat(43) } }),
      ).toEqual({ status: 404, json: { error: "not_found" } });
    }
    const { userCode } = (await api(relay, { path: "/api/host-link/start", body: startBody })).json;
    expect((await api(relay, { path: "/api/host-link/lookup", headers: bearer(token), body: { userCode } })).status).toBe(200);
  });

  it("accepts only an http://127.0.0.1:<port> redirect, a well-formed challenge and a state", async () => {
    const { relay } = await serve();
    const { challenge } = pkce();
    const base = { ...startBody, redirectUri: REDIRECT, codeChallenge: challenge, state: "s" };
    for (const body of [
      { ...base, redirectUri: "https://127.0.0.1:54321/callback" },
      { ...base, redirectUri: "http://localhost:54321/callback" },
      { ...base, redirectUri: "http://[::1]:54321/callback" },
      { ...base, redirectUri: "http://127.0.0.1/callback" },
      { ...base, redirectUri: "http://user@127.0.0.1:54321/callback" },
      { ...base, redirectUri: "http://127.0.0.1:54321/callback#x" },
      { ...base, redirectUri: "http://127.0.0.1:54321/callback?x=1" },
      { ...base, redirectUri: `http://127.0.0.1:54321/${"a".repeat(300)}` },
      { ...base, codeChallenge: "short" },
      { ...base, codeChallenge: undefined },
      { ...base, state: undefined },
      { ...base, state: "s".repeat(200) },
    ]) {
      expect(await api(relay, { path: "/api/host-link/start", body })).toEqual({ status: 400, json: { error: "invalid_request" } });
    }
  });

  it("needs no Origin and no session to trade a code, and refuses malformed bodies", async () => {
    const { relay } = await serve();
    for (const body of [{}, { code: "c" }, { code: 1, codeVerifier: "v" }]) {
      expect(await api(relay, { path: "/api/host-link/token", body })).toEqual({ status: 400, json: { error: "invalid_request" } });
    }
    expect(
      await api(relay, { path: "/api/host-link/token", headers: { origin: "https://evil.example" }, body: { code: "c", codeVerifier: "v".repeat(43) } }),
    ).toEqual({ status: 403, json: { error: "origin_mismatch" } });
  });
});
