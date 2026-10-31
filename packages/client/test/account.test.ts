// The shared account client: verdicts, error mapping, credential modes, and
// the host-list ↔ stored-pairing matching. Server behavior is faked at the
// fetch seam here; a real server drives the end-to-end pass in
// apps/host/test/account-client.test.ts.
import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import {
  accountPairingFragment,
  createAccountClient,
  isSecureServerOrigin,
  isUnauthenticated,
  matchAccountHosts,
  normalizeServerOrigin,
  pairViaAccount,
  PairingHandshakeError,
  probeAccounts,
  type AccountFetch,
  type AccountFetchInit,
  type AccountHost,
  type PairConnectArgs,
} from "../src/account.ts";
import type { StoredHost } from "../src/stored-host.ts";

const ORIGIN = "https://relay.example.com";

/** A fetch stand-in: records calls, answers from a script of status+body. */
const fakeFetch = (...script: { status: number; body?: unknown }[]) => {
  const calls: { url: string; init: AccountFetchInit | undefined }[] = [];
  const impl: AccountFetch = (url, init) => {
    calls.push({ url, init });
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next === undefined) return Promise.reject(new Error("no scripted response"));
    return Promise.resolve({
      status: next.status,
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
    });
  };
  return { impl, calls };
};

const failingFetch: AccountFetch = () => Promise.reject(new Error("ECONNREFUSED"));

const bearer = (script: { status: number; body?: unknown }[], token = "tok") =>
  createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token }, fetch: fakeFetch(...script).impl });

describe("probeAccounts", () => {
  it("reads the account API's own answers", async () => {
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 401 }).impl)).toBe("enabled");
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 200, body: { user: { username: "a" } } }).impl)).toBe("enabled");
    // A 200 that isn't the API — the SPA's index.html, fully read but not
    // JSON — means no accounts. It must not collapse into "unreachable".
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 200, body: "<html>app</html>" }).impl)).toBe("disabled");
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 200, body: "not json at all" }).impl)).toBe("disabled");
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 404, body: { error: "accounts_disabled" } }).impl)).toBe(
      "disabled",
    );
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 502 }).impl)).toBe("unreachable");
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 403 }).impl)).toBe("unreachable");
    expect(await probeAccounts(ORIGIN, failingFetch)).toBe("unreachable");
  });

  it("calls a stalled or cut body unreachable, not disabled", async () => {
    // Headers arrive (200) but the body never reads — a half-dead proxy. This
    // is what the probe's timeout exists for.
    const cut: AccountFetch = () =>
      Promise.resolve({
        status: 200,
        json: () => Promise.reject(new Error("body stream aborted")),
        text: () => Promise.reject(new Error("body stream aborted")),
      });
    expect(await probeAccounts(ORIGIN, cut)).toBe("unreachable");
    const hung: AccountFetch = (_url, init) =>
      Promise.resolve({
        status: 200,
        json: () =>
          new Promise<unknown>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          ),
        text: () =>
          new Promise<string>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          ),
      });
    expect(await probeAccounts(ORIGIN, hung)).toBe("unreachable"); // 5s probe timeout
  });

  it("strips a trailing slash from the origin", async () => {
    const { impl, calls } = fakeFetch({ status: 401 });
    await probeAccounts(`${ORIGIN}/`, impl);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/me`);
  });

  it("does not follow redirects", async () => {
    const { impl, calls } = fakeFetch({ status: 401 });
    await probeAccounts(ORIGIN, impl);
    expect(calls[0]!.init?.redirect).toBe("manual");
    // A 3xx answer can't prove the account API — same as a proxy 502.
    expect(await probeAccounts(ORIGIN, fakeFetch({ status: 307 }).impl)).toBe("unreachable");
  });
});

describe("isSecureServerOrigin", () => {
  it("requires https outside loopback", () => {
    expect(isSecureServerOrigin("https://relay.example.com")).toBe(true);
    expect(isSecureServerOrigin("https://relay.example.com:8443")).toBe(true);
    expect(isSecureServerOrigin("http://relay.example.com")).toBe(false);
    expect(isSecureServerOrigin("http://192.168.1.5:7430")).toBe(false);
    // A domain that merely starts with "127." is a remote host, not loopback.
    expect(isSecureServerOrigin("http://127.example.com")).toBe(false);
    expect(isSecureServerOrigin("http://127.0.0.1.example.com")).toBe(false);
    expect(isSecureServerOrigin("http://localhost.example.com")).toBe(false);
    // IPv4-mapped IPv6 and a trailing-dot localhost normalize outside the
    // loopback rule — refused rather than guessed.
    expect(isSecureServerOrigin("http://[::ffff:127.0.0.1]")).toBe(false);
    expect(isSecureServerOrigin("http://localhost.")).toBe(false);
    expect(isSecureServerOrigin("ws://relay.example.com")).toBe(false);
    expect(isSecureServerOrigin("not a url")).toBe(false);
    expect(isSecureServerOrigin("")).toBe(false);
  });

  it("allows loopback http for development", () => {
    expect(isSecureServerOrigin("http://127.0.0.1:7430")).toBe(true);
    // WHATWG normalizes the shorthand spellings to real 127/8 addresses.
    expect(isSecureServerOrigin("http://127.1")).toBe(true);
    expect(isSecureServerOrigin("http://127.255.255.254")).toBe(true);
    expect(isSecureServerOrigin("http://128.0.0.1")).toBe(false);
    expect(isSecureServerOrigin("http://localhost:7430")).toBe(true);
    expect(isSecureServerOrigin("http://dev.localhost:7430")).toBe(true);
    expect(isSecureServerOrigin("http://[::1]:7430")).toBe(true);
  });
});

describe("normalizeServerOrigin", () => {
  it("canonicalizes trailing slashes and default ports", () => {
    expect(normalizeServerOrigin("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeServerOrigin("https://relay.example.com:443")).toBe("https://relay.example.com");
    expect(normalizeServerOrigin("http://127.0.0.1:7430/")).toBe("http://127.0.0.1:7430");
  });
});

describe("account client", () => {
  it("bearer mode sets Authorization and returns the login token", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { user: { username: "admin" }, expiresAt: 1, token: "the-token" },
    });
    const client = createAccountClient({ origin: `${ORIGIN}/`, credentials: { mode: "bearer", token: "tok" }, fetch: impl });
    expect(client.origin).toBe(ORIGIN); // normalized

    const result = await client.login("admin", "pw");
    expect(result).toEqual({ ok: true, value: { user: { username: "admin" }, expiresAt: 1, token: "the-token" } });
    // Login itself carries the stored bearer — the server ignores it for /api/login.
    expect(calls[0]!.init?.headers?.authorization).toBe("Bearer tok");
    expect(calls[0]!.init?.credentials).toBeUndefined();
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  it("cookie mode sends same-origin credentials and no token ever leaves the body", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { user: { username: "admin" }, expiresAt: 1 } });
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "cookie" }, fetch: impl });

    const result = await client.login("admin", "pw");
    // No token field: the session rides the HttpOnly cookie only.
    expect(result).toEqual({ ok: true, value: { user: { username: "admin" }, expiresAt: 1 } });
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(calls[0]!.init?.headers?.authorization).toBeUndefined();
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  it("never follows redirects — a 3xx answer is an error, an opaque redirect is network", async () => {
    // undici hands back the real 3xx under `redirect: "manual"`: it maps to
    // a plain API failure like any other non-2xx.
    const redirecting = bearer([{ status: 307 }]);
    expect(await redirecting.me()).toEqual({ ok: false, error: { code: "unknown", status: 307 } });
    // DOM fetch answers an opaqueredirect (status 0) — the target is
    // invisible, so it reads as a transport failure, not an API answer.
    const opaque = bearer([{ status: 0 }]);
    expect(await opaque.me()).toEqual({ ok: false, error: { code: "network" } });
  });

  it("maps server error codes through verbatim", async () => {
    const client = bearer([{ status: 401, body: { error: "invalid_credentials" } }]);
    const bad = await client.login("admin", "wrong");
    expect(bad).toEqual({ ok: false, error: { code: "invalid_credentials", status: 401 } });
    expect(isUnauthenticated((bad as { error: { code: string } }).error)).toBe(false);

    const expired = bearer([{ status: 401, body: { error: "unauthenticated" } }]);
    const result = await expired.listHosts();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isUnauthenticated(result.error)).toBe(true);

    for (const [status, code] of [
      [429, "rate_limited"],
      [404, "accounts_disabled"],
      [404, "not_found"],
      [409, "host_offline"],
      [504, "host_timeout"],
    ] as const) {
      const c = bearer([{ status, body: { error: code } }]);
      const r = await c.listHosts();
      expect(r).toEqual({ ok: false, error: { code, status } });
    }
  });

  it("reports network failure and unparseable bodies without codes", async () => {
    const dead = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: failingFetch });
    expect(await dead.me()).toEqual({ ok: false, error: { code: "network" } });

    const html = bearer([{ status: 502, body: "<html>bad gateway</html>" }]);
    const result = await html.me();
    expect(result).toEqual({ ok: false, error: { code: "unknown", status: 502 } });
  });

  it("validates response shapes instead of trusting them", async () => {
    const client = bearer([{ status: 200, body: { user: "not-an-object" } }]);
    expect(await client.me()).toEqual({ ok: false, error: { code: "invalid_response" } });

    const badHosts = bearer([{ status: 200, body: [{ hostId: "x" }] }]);
    expect(await badHosts.listHosts()).toEqual({ ok: false, error: { code: "invalid_response" } });

    const badOffer = bearer([{ status: 200, body: { url: "wss://x" } }]);
    expect(await badOffer.requestPairing("host")).toEqual({ ok: false, error: { code: "invalid_response" } });
  });

  it("logout and revoke-all take 204s as success", async () => {
    const { impl } = fakeFetch({ status: 204 });
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: impl });
    expect(await client.logout()).toEqual({ ok: true, value: undefined });
    expect(await client.revokeAllSessions()).toEqual({ ok: true, value: undefined });
  });

  it("deletes the account with its password; the 403 refusals aren't sign-outs (#451)", async () => {
    const { impl, calls } = fakeFetch(
      { status: 403, body: { error: "wrong_password" } },
      { status: 403, body: { error: "admin_account" } },
      { status: 204 },
    );
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: impl });
    const wrong = await client.deleteAccount("nope");
    expect(wrong).toEqual({ ok: false, error: { code: "wrong_password", status: 403 } });
    expect(isUnauthenticated((wrong as { error: { code: string } }).error)).toBe(false);
    expect(await client.deleteAccount("pw")).toEqual({ ok: false, error: { code: "admin_account", status: 403 } });
    expect(await client.deleteAccount("pw")).toEqual({ ok: true, value: undefined });
    expect(calls[2]!.url).toBe(`${ORIGIN}/api/me/delete`);
    expect(calls[2]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[2]!.init!.body as string)).toEqual({ password: "pw" });
  });

  it("parses the hosts list and join tokens", async () => {
    const host = {
      hostId: "h",
      name: "omarchy",
      noisePublicKey: "k",
      online: true,
      lastSeenAt: 7,
      pairing: "available",
    };
    const { impl, calls } = fakeFetch(
      { status: 200, body: [host] },
      { status: 200, body: { token: "jt", expiresAt: 9, command: "pinomad join https://x jt" } },
    );
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: impl });
    expect(await client.listHosts()).toEqual({ ok: true, value: [host] });
    expect(await client.createJoinToken()).toEqual({
      ok: true,
      value: { token: "jt", expiresAt: 9, command: "pinomad join https://x jt" },
    });
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[1]!.init?.method).toBe("POST");
  });
});

const HOST_ID = toBase64Url(generateKeyPair().publicKey);
const OTHER_ID = toBase64Url(generateKeyPair().publicKey);
const accountHost = (overrides?: Partial<AccountHost>): AccountHost => ({
  hostId: HOST_ID,
  name: "omarchy",
  noisePublicKey: toBase64Url(generateKeyPair().publicKey),
  online: true,
  lastSeenAt: 1,
  pairing: "available",
  ...overrides,
});
const stored = (overrides?: Partial<StoredHost>): StoredHost => ({
  url: "wss://relay.example.com/c/x",
  hostKey: toBase64Url(generateKeyPair().publicKey),
  privateKey: toBase64Url(generateKeyPair().privateKey),
  ...overrides,
});

describe("sign-up and invites (#449)", () => {
  it("signs up with an invite and reads the session like a login", async () => {
    const fetch = fakeFetch({ status: 200, body: { user: { username: "bob" }, expiresAt: 9, token: "t" } });
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer" }, fetch: fetch.impl });
    const result = await client.register("code", "bob", "long password here");
    expect(result).toEqual({ ok: true, value: { user: { username: "bob" }, expiresAt: 9, token: "t" } });
    expect(fetch.calls[0]!.url).toBe(`${ORIGIN}/api/register`);
    expect(JSON.parse(fetch.calls[0]!.init!.body!)).toEqual({ invite: "code", username: "bob", password: "long password here" });

    const refused = await bearer([{ status: 403, body: { error: "invite_expired" } }]).register("c", "bob", "x");
    expect(refused).toEqual({ ok: false, error: { code: "invite_expired", status: 403 } });
  });

  it("carries the admin flag from login and /api/me, absent for everyone else", async () => {
    const admin = await bearer([{ status: 200, body: { user: { username: "a" }, admin: true, expiresAt: 1, token: "t" } }]).login("a", "p");
    expect(admin.ok && admin.value.admin).toBe(true);
    const plain = await bearer([{ status: 200, body: { user: { username: "b" }, expiresAt: 1, token: "t" } }]).login("b", "p");
    expect(plain.ok && plain.value.admin).toBeUndefined();
    expect(await bearer([{ status: 200, body: { user: { username: "a" }, admin: true } }]).me()).toEqual({
      ok: true,
      value: { user: { username: "a" }, admin: true },
    });
    expect(await bearer([{ status: 200, body: { user: { username: "b" } } }]).me()).toEqual({
      ok: true,
      value: { user: { username: "b" } },
    });
  });

  it("lists, creates and revokes invites, refusing malformed rows", async () => {
    const rows = [
      { id: 2, createdAt: 5, expiresAt: 10 },
      { id: 1, createdAt: 1, expiresAt: 8, usedAt: 3, usedBy: "bob" },
    ];
    expect(await bearer([{ status: 200, body: rows }]).listInvites()).toEqual({ ok: true, value: rows });
    expect((await bearer([{ status: 200, body: [{ id: "1", createdAt: 1, expiresAt: 2 }] }]).listInvites()).ok).toBe(false);
    expect(await bearer([{ status: 200, body: { code: "c", expiresAt: 4 } }]).createInvite()).toEqual({
      ok: true,
      value: { code: "c", expiresAt: 4 },
    });
    const fetch = fakeFetch({ status: 204 });
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: fetch.impl });
    expect(await client.revokeInvite(7)).toEqual({ ok: true, value: undefined });
    expect(fetch.calls[0]!.url).toBe(`${ORIGIN}/api/invites/revoke`);
    expect(JSON.parse(fetch.calls[0]!.init!.body!)).toEqual({ id: 7 });
  });
});

describe("account devices (#452)", () => {
  const DEVICE_ID = "AAAAAAAAAAAAAAAAAAAAAA";

  it("claims this device at login and sign-up, and only when asked to", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { user: { username: "a" }, expiresAt: 1, token: "t" } });
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer" }, fetch: impl });
    await client.login("a", "p", { id: DEVICE_ID, name: "Mac Chrome" });
    await client.register("code", "a", "p", { id: DEVICE_ID });
    await client.login("a", "p");
    expect(calls[0]!.init!.body).toBe(`{"username":"a","password":"p","device":{"id":"${DEVICE_ID}","name":"Mac Chrome"}}`);
    expect(JSON.parse(calls[1]!.init!.body!)).toEqual({ invite: "code", username: "a", password: "p", device: { id: DEVICE_ID } });
    expect(JSON.parse(calls[2]!.init!.body!)).toEqual({ username: "a", password: "p" });
  });

  it("lists the account's devices with their standing on each host", async () => {
    const rows = [
      {
        id: 3,
        name: "Mac Chrome",
        createdAt: 1,
        lastSeenAt: 5,
        current: true,
        hosts: [
          { hostId: "h1", name: "omarchy", state: "registered" },
          { hostId: "h2", name: "studio", state: "revoking" },
        ],
      },
      { id: 2, createdAt: 1, lastSeenAt: 2, current: false, kickedAt: 4, hosts: [{ hostId: "h1", name: "omarchy", state: "revoked" }] },
    ];
    const { impl, calls } = fakeFetch({ status: 200, body: rows });
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: impl });
    expect(await client.listDevices()).toEqual({ ok: true, value: rows });
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/devices`);
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("refuses device rows that don't match the shape", async () => {
    const good = { id: 1, createdAt: 1, lastSeenAt: 1, current: false, hosts: [] };
    for (const bad of [
      { ...good, id: "1" },
      { ...good, current: "no" },
      { ...good, name: 4 },
      { ...good, kickedAt: "x" },
      { ...good, hosts: {} },
      { ...good, hosts: [{ hostId: "h", name: "n", state: "gone" }] },
    ]) {
      expect(await bearer([{ status: 200, body: [bad] }]).listDevices()).toEqual({ ok: false, error: { code: "invalid_response" } });
    }
    expect(await bearer([{ status: 200, body: {} }]).listDevices()).toEqual({ ok: false, error: { code: "invalid_response" } });
    expect(await bearer([{ status: 401 }]).listDevices()).toEqual({ ok: false, error: { code: "unauthenticated", status: 401 } });
  });

  it("kicks a device by the server's id with the password; refusals keep their codes", async () => {
    const { impl, calls } = fakeFetch(
      { status: 204 },
      { status: 403, body: { error: "wrong_password" } },
      { status: 409, body: { error: "current_device" } },
      { status: 429, body: { error: "rate_limited" } },
      { status: 401, body: { error: "unauthenticated" } },
    );
    const client = createAccountClient({ origin: ORIGIN, credentials: { mode: "bearer", token: "t" }, fetch: impl });
    expect(await client.kickDevice(12, "pw")).toEqual({ ok: true, value: undefined });
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/devices/12/kick`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({ password: "pw" });
    const wrong = await client.kickDevice(12, "nope");
    expect(wrong).toEqual({ ok: false, error: { code: "wrong_password", status: 403 } });
    expect(isUnauthenticated((wrong as { error: { code: string } }).error)).toBe(false);
    expect(await client.kickDevice(3, "pw")).toEqual({ ok: false, error: { code: "current_device", status: 409 } });
    expect(await client.kickDevice(12, "pw")).toEqual({ ok: false, error: { code: "rate_limited", status: 429 } });
    const gone = await client.kickDevice(12, "pw");
    expect(gone.ok === false && isUnauthenticated(gone.error)).toBe(true);
  });

  it("reads whether a host reports devices, absent on older servers", async () => {
    const host = { hostId: "h", name: "n", noisePublicKey: "k", online: true, lastSeenAt: 1, pairing: "available" };
    expect(await bearer([{ status: 200, body: [{ ...host, deviceReports: false }] }]).listHosts()).toEqual({
      ok: true,
      value: [{ ...host, deviceReports: false }],
    });
    expect(await bearer([{ status: 200, body: [host] }]).listHosts()).toEqual({ ok: true, value: [host] });
    expect((await bearer([{ status: 200, body: [{ ...host, deviceReports: "yes" }] }]).listHosts()).ok).toBe(false);
  });
});

describe("matchAccountHosts", () => {
  it("pairs a linked entry, adopts an unlinked twin, and leaves strangers unpaired", async () => {
    const linked = stored({ account: { serverOrigin: `${ORIGIN}/`, hostId: HOST_ID } });
    const twin = stored();
    const stranger = stored();
    const hosts = [
      accountHost({ noisePublicKey: linked.hostKey }),
      accountHost({ hostId: OTHER_ID, noisePublicKey: twin.hostKey }),
      accountHost({ hostId: "unpaired-id", noisePublicKey: toBase64Url(generateKeyPair().publicKey) }),
    ];
    const matches = matchAccountHosts(ORIGIN, hosts, [linked, twin, stranger], [], true);
    expect(matches.map((m) => m.status)).toEqual(["paired", "paired", "unpaired"]);
    expect(matches[0]!.stored).toBe(linked);
    expect(matches[0]!.linkable).toBe(false);
    expect(matches[1]!.stored).toBe(twin);
    // The twin predates account linkage — the caller may persist the link.
    expect(matches[1]!.linkable).toBe(true);
    expect(matches[2]!.stored).toBeUndefined();
    expect(matches[2]!.linkable).toBe(false);
  });

  it("reports a changed Noise key without offering to re-pair", () => {
    const entry = stored({ account: { serverOrigin: ORIGIN, hostId: HOST_ID } });
    const rotated = accountHost({ noisePublicKey: toBase64Url(generateKeyPair().publicKey) });
    const [match] = matchAccountHosts(ORIGIN, [rotated], [entry], [], true);
    expect(match).toMatchObject({ status: "key_changed", stored: entry, linkable: false });
  });

  it("prefers the linked entry whose key still matches among duplicates", () => {
    // Re-pairing after a key change stores a fresh record under the new key
    // while the stale link survives until cleanup — the live record must win.
    const stale = stored({ account: { serverOrigin: ORIGIN, hostId: HOST_ID } });
    const fresh = stored({ account: { serverOrigin: ORIGIN, hostId: HOST_ID } });
    const host = accountHost({ noisePublicKey: fresh.hostKey });
    const [match] = matchAccountHosts(ORIGIN, [host], [stale, fresh], [], true);
    expect(match).toMatchObject({ status: "paired", stored: fresh, linkable: false });
  });

  it("scopes the account link by origin: the same hostId elsewhere doesn't match", () => {
    const entry = stored({ account: { serverOrigin: "https://other.example.com", hostId: HOST_ID } });
    const host = accountHost({ noisePublicKey: toBase64Url(generateKeyPair().publicKey) });
    const [match] = matchAccountHosts(ORIGIN, [host], [entry], [], true);
    expect(match!.status).toBe("unpaired");
  });

  it("offers auto-registration only to unpaired hosts outside the declined set", () => {
    const pairedKey = toBase64Url(generateKeyPair().publicKey);
    const paired = stored({ hostKey: pairedKey, account: { serverOrigin: ORIGIN, hostId: "paired-id" } });
    const changed = stored({ account: { serverOrigin: ORIGIN, hostId: "changed-id" } });
    const hosts = [
      accountHost({ hostId: "fresh-id" }),
      accountHost({ hostId: "declined-id" }),
      accountHost({ hostId: "changed-id", noisePublicKey: toBase64Url(generateKeyPair().publicKey) }),
      accountHost({ hostId: "paired-id", noisePublicKey: pairedKey }),
    ];
    const matches = matchAccountHosts(
      ORIGIN,
      hosts,
      [paired, changed],
      [{ serverOrigin: `${ORIGIN}/`, hostId: "declined-id" }],
      true,
    );
    expect(matches.map((match) => match.status)).toEqual(["unpaired", "unpaired", "key_changed", "paired"]);
    expect(matches.map((match) => match.autoRegister)).toEqual([true, false, false, false]);
  });

  it("never auto-registers when the stored list could not be read", () => {
    const host = accountHost();
    const [failed] = matchAccountHosts(ORIGIN, [host], [], [], false);
    expect(failed).toMatchObject({ status: "unpaired", autoRegister: false });
    // The same host with a successful (empty) read is eligible: an empty list
    // means "nothing paired", not "we don't know".
    const [read] = matchAccountHosts(ORIGIN, [host], [], [], true);
    expect(read!.autoRegister).toBe(true);
  });

  it("scopes declined entries by normalized origin and host id", () => {
    const host = accountHost({ hostId: "declined-id" });
    const [elsewhere] = matchAccountHosts(
      ORIGIN,
      [host],
      [],
      [{ serverOrigin: "https://other.example.com", hostId: "declined-id" }],
      true,
    );
    expect(elsewhere!.autoRegister).toBe(true);
    const [declined] = matchAccountHosts(
      ORIGIN,
      [host],
      [],
      [{ serverOrigin: `${ORIGIN}:443/`, hostId: "declined-id" }],
      true,
    );
    expect(declined!.autoRegister).toBe(false);
  });
});

describe("accountPairingFragment + pairViaAccount", () => {
  const offer = () => ({
    url: "wss://relay.example.com/c/host",
    hostKey: toBase64Url(generateKeyPair().publicKey),
    secret: toBase64Url(generateKeyPair().privateKey),
    expiresAt: Date.now() + 60_000,
  });

  it("normalizes an offer into the fragment the existing flow reads", () => {
    const fragment = accountPairingFragment(offer());
    expect(fragment).toMatch(/^pair=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+&url=/);
    const params = new URLSearchParams(fragment!);
    expect(params.get("url")).toBe("wss://relay.example.com/c/host");
  });

  it("refuses an offer whose url isn't a socket", () => {
    expect(accountPairingFragment({ ...offer(), url: "https://evil.example.com" })).toBeUndefined();
    expect(accountPairingFragment({ ...offer(), hostKey: "short" })).toBeUndefined();
  });

  it("pairs via the injected handshake and returns a linkable StoredHost", async () => {
    const client = bearer([{ status: 200, body: offer() }]);
    let seen: { url?: string; name?: string } = {};
    const result = await pairViaAccount(client, HOST_ID, "test device", (args) => {
      seen = args;
      return Promise.resolve();
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("wss://relay.example.com/c/host");
    expect(result.value.account).toEqual({ serverOrigin: ORIGIN, hostId: HOST_ID });
    expect(seen.name).toBe("test device");
    expect(seen.url).toBe("wss://relay.example.com/c/host");
  });

  it("carries a forwarded endpoint set through the offer and the stored host", async () => {
    const endpointSet = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://relay.example.com/c/host" },
        { transport: "webSocket" as const, role: "direct" as const, url: "ws://192.168.1.5:7422/secure" },
      ],
    };
    const offered = { ...offer(), endpointSet };
    const fragment = accountPairingFragment(offered);
    expect(fragment).toBeDefined();
    const params = new URLSearchParams(fragment!);
    expect(JSON.parse(params.get("endpointSet")!)).toEqual(endpointSet);

    const client = bearer([{ status: 200, body: offered }]);
    const result = await pairViaAccount(client, HOST_ID, "d", () => Promise.resolve());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpointSet).toEqual(endpointSet);
    expect(result.value.url).toBe("wss://relay.example.com/c/host");
  });

  it("tries every candidate with one device identity and one secret until message 2", async () => {
    const endpointSet = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://dead-relay.example/c/host" },
        { transport: "webSocket" as const, role: "direct" as const, url: "wss://direct.example/c/host" },
      ],
    };
    const client = bearer([{ status: 200, body: { ...offer(), endpointSet } }]);
    const attempts: PairConnectArgs[] = [];
    const result = await pairViaAccount(client, HOST_ID, "d", (args) => {
      attempts.push(args);
      return attempts.length === 1 ? Promise.reject(new Error("relay offline")) : Promise.resolve();
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(attempts.map((attempt) => attempt.url)).toEqual([
      "wss://dead-relay.example/c/host",
      "wss://direct.example/c/host",
    ]);
    expect(attempts[0]!.device.privateKey).toEqual(attempts[1]!.device.privateKey);
    expect(attempts[0]!.secret).toBe(attempts[1]!.secret);
    expect(attempts[0]!.signal).toBeDefined();
    expect(result.value.privateKey).toBe(toBase64Url(attempts[0]!.device.privateKey));
  });

  it("rejects malformed or explicitly empty forwarded sets", async () => {
    for (const endpointSet of [
      { schemaVersion: 1, endpoints: [] },
      { schemaVersion: 1, endpoints: "junk" },
      { schemaVersion: 1, endpoints: [{ transport: "webSocket", role: "relay", url: "http://relay" }] },
    ]) {
      const client = bearer([{ status: 200, body: { ...offer(), endpointSet } }]);
      expect(await client.requestPairing("host")).toEqual({ ok: false, error: { code: "invalid_response" } });
    }
    // An unknown schema/transport falls back to the legacy url, as old servers do.
    const fallback = bearer([
      {
        status: 200,
        body: {
          ...offer(),
          endpointSet: { schemaVersion: 2, endpoints: [{ transport: "quic", role: "relay", url: "quic://x" }] },
        },
      },
    ]);
    const parsed = await fallback.requestPairing("host");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.endpointSet).toBeUndefined();
  });

  it("propagates the server's refusal and never opens a socket", async () => {
    const client = bearer([{ status: 409, body: { error: "host_offline" } }]);
    let dialed = false;
    const result = await pairViaAccount(client, HOST_ID, "d", () => {
      dialed = true;
      return Promise.resolve();
    });
    expect(result).toEqual({ ok: false, error: { code: "host_offline", status: 409 } });
    expect(dialed).toBe(false);
  });

  it("turns a rejected handshake into pair_rejected with its path evidence", async () => {
    const client = bearer([{ status: 200, body: offer() }]);
    const result = await pairViaAccount(client, HOST_ID, "d", () => Promise.reject(new Error("closed 4401")));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_rejected",
        candidates: [{ outcome: "rejected", code: 4401, role: "legacy", url: "wss://relay.example.com/c/host" }],
      },
    });
  });

  it("reports an HTTPS page's unsupported candidates without dialing", async () => {
    const endpointSet = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://relay.example.com/c/host" },
        { transport: "webSocket" as const, role: "direct" as const, url: "ws://192.168.1.5:7422/secure" },
      ],
    };
    const client = bearer([{ status: 200, body: { ...offer(), endpointSet } }]);
    let dialed = 0;
    const result = await pairViaAccount(
      client,
      HOST_ID,
      "d",
      () => {
        dialed += 1;
        return Promise.reject(new Error("relay offline"));
      },
      { pageProtocol: "https:" },
    );
    expect(dialed).toBe(1); // the wss relay was dialed; the ws direct was not
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_unreachable",
        candidates: [
          { outcome: "unreachable", role: "relay", url: "wss://relay.example.com/c/host" },
          { outcome: "unsupported", role: "direct", url: "ws://192.168.1.5:7422/secure" },
        ],
      },
    });

    // An unsupported-only offer never dials and is not reported as a refusal.
    const onlyDirect = bearer([
      {
        status: 200,
        body: {
          ...offer(),
          endpointSet: {
            schemaVersion: 1,
            endpoints: [
              { transport: "webSocket", role: "direct", url: "ws://192.168.1.5:7422/secure" },
              { transport: "webSocket", role: "direct", url: "ws://192.168.1.6:7422/secure" },
            ],
          },
        },
      },
    ]);
    const noDial = await pairViaAccount(
      onlyDirect,
      HOST_ID,
      "d",
      () => {
        throw new Error("must not dial");
      },
      { pageProtocol: "https:" },
    );
    expect(noDial).toMatchObject({
      ok: false,
      error: {
        code: "pair_unsupported",
        candidates: [
          { outcome: "unsupported", role: "direct", reason: expect.stringContaining("mixed content") },
          { outcome: "unsupported", role: "direct", reason: expect.stringContaining("mixed content") },
        ],
      },
    });
  });

  it("reports unreachable paths separately from a refusal", async () => {
    const client = bearer([{ status: 200, body: offer() }]);
    const result = await pairViaAccount(client, HOST_ID, "d", () =>
      Promise.reject(new Error("ECONNRESET")),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_unreachable",
        candidates: [{ outcome: "unreachable", role: "legacy", reason: "ECONNRESET" }],
      },
    });
  });

  it("classifies a typed 4401 close as a refusal", async () => {
    const client = bearer([{ status: 200, body: offer() }]);
    const result = await pairViaAccount(client, HOST_ID, "d", () =>
      Promise.reject(new PairingHandshakeError(4401)),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pair_rejected", candidates: [{ outcome: "rejected", code: 4401 }] },
    });
  });

  it("keeps a rejection's code when another path is unsupported", async () => {
    const endpointSet = {
      schemaVersion: 1 as const,
      endpoints: [
        { transport: "webSocket" as const, role: "relay" as const, url: "wss://relay.example.com/c/host" },
        { transport: "webSocket" as const, role: "direct" as const, url: "ws://192.168.1.5:7422/secure" },
      ],
    };
    const client = bearer([{ status: 200, body: { ...offer(), endpointSet } }]);
    const result = await pairViaAccount(
      client,
      HOST_ID,
      "d",
      () => Promise.reject(new PairingHandshakeError(4401)),
      { pageProtocol: "https:" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_rejected",
        candidates: [
          { outcome: "rejected", code: 4401 },
          { outcome: "unsupported", role: "direct" },
        ],
      },
    });
  });

  const twoPaths = (): { schemaVersion: 1; endpoints: { transport: "webSocket"; role: "relay" | "direct"; url: string }[] } => ({
    schemaVersion: 1,
    endpoints: [
      { transport: "webSocket", role: "relay", url: "wss://relay.example.com/c/host" },
      { transport: "webSocket", role: "direct", url: "wss://direct.example.com/secure" },
    ],
  });

  it("does not let one rejected relay override a direct timeout", async () => {
    const client = bearer([{ status: 200, body: { ...offer(), endpointSet: twoPaths() } }]);
    let calls = 0;
    const result = await pairViaAccount(
      client,
      HOST_ID,
      "d",
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new PairingHandshakeError(4401)) : new Promise<void>(() => {});
      },
      { attemptTimeoutMs: 5 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_timeout",
        candidates: [
          { outcome: "rejected", code: 4401, role: "relay" },
          { outcome: "timeout", role: "direct" },
        ],
      },
    });
  });

  it("does not let one rejected relay override a direct unreachable path", async () => {
    const client = bearer([{ status: 200, body: { ...offer(), endpointSet: twoPaths() } }]);
    let calls = 0;
    const result = await pairViaAccount(client, HOST_ID, "d", () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new PairingHandshakeError(4401))
        : Promise.reject(new Error("ECONNRESET"));
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_unreachable",
        candidates: [
          { outcome: "rejected", code: 4401, role: "relay" },
          { outcome: "unreachable", reason: "ECONNRESET", role: "direct" },
        ],
      },
    });
  });

  it("calls the round rejected only when every dialed path was rejected", async () => {
    const client = bearer([{ status: 200, body: { ...offer(), endpointSet: twoPaths() } }]);
    const result = await pairViaAccount(client, HOST_ID, "d", () =>
      Promise.reject(new PairingHandshakeError(4401)),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pair_rejected",
        candidates: [
          { outcome: "rejected", code: 4401, role: "relay" },
          { outcome: "rejected", code: 4401, role: "direct" },
        ],
      },
    });
  });

  it("reports a pairing deadline as a timeout, not a refusal", async () => {
    const client = bearer([{ status: 200, body: offer() }]);
    const result = await pairViaAccount(
      client,
      HOST_ID,
      "d",
      () => new Promise<void>(() => {}),
      { attemptTimeoutMs: 10 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pair_timeout", candidates: [{ outcome: "timeout", role: "legacy" }] },
    });
  });
});
