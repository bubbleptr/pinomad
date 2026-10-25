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
    const matches = matchAccountHosts(ORIGIN, hosts, [linked, twin, stranger]);
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
    const [match] = matchAccountHosts(ORIGIN, [rotated], [entry]);
    expect(match).toMatchObject({ status: "key_changed", stored: entry, linkable: false });
  });

  it("prefers the linked entry whose key still matches among duplicates", () => {
    // Re-pairing after a key change stores a fresh record under the new key
    // while the stale link survives until cleanup — the live record must win.
    const stale = stored({ account: { serverOrigin: ORIGIN, hostId: HOST_ID } });
    const fresh = stored({ account: { serverOrigin: ORIGIN, hostId: HOST_ID } });
    const host = accountHost({ noisePublicKey: fresh.hostKey });
    const [match] = matchAccountHosts(ORIGIN, [host], [stale, fresh]);
    expect(match).toMatchObject({ status: "paired", stored: fresh, linkable: false });
  });

  it("scopes the account link by origin: the same hostId elsewhere doesn't match", () => {
    const entry = stored({ account: { serverOrigin: "https://other.example.com", hostId: HOST_ID } });
    const host = accountHost({ noisePublicKey: toBase64Url(generateKeyPair().publicKey) });
    const [match] = matchAccountHosts(ORIGIN, [host], [entry]);
    expect(match!.status).toBe("unpaired");
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
            endpoints: [{ transport: "webSocket", role: "direct", url: "ws://192.168.1.5:7422/secure" }],
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
        candidates: [{ outcome: "unsupported", role: "direct", reason: expect.stringContaining("mixed content") }],
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
