// Shared inputs for the account-client vectors (packages/client/test/
// rust-vectors.ts): request shapes, canned responses, probe verdicts, the
// origin rules, host matching, and pairing offers. Values are deterministic
// — the committed fixtures are ground truth the Rust side replays.
import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { AccountHost, PairingOffer } from "../src/account.ts";
import type { StoredHost } from "../src/stored-host.ts";

const key = (fill: number) => toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(fill)).publicKey);

export const ACCOUNT_ORIGIN = "https://relay.example.com";
// hostIds and keys are interchangeable base64url-32 strings; distinct fills
// keep "which entry matched" unambiguous in the fixtures.
export const HOST_ID_A = key(11);
export const HOST_ID_B = key(12);
const NOISE_A = key(13);
const NOISE_B = key(14);
const NOISE_C = key(15);
const NOISE_ROTATED = key(16);
const STORE_KEY_A = key(17);
const STORE_KEY_B = key(18);
const STORE_KEY_C = key(19);
const STORE_KEY_D = key(20);
const STORE_KEY_E = key(21);
const STORE_KEY_F = key(22);
const PRIV = key(23);
const OFFER_KEY = key(24);
const OFFER_SECRET = key(25);

export type AccountOpDesc =
  | { kind: "login"; username: string; password: string }
  | { kind: "requestPairing"; hostId: string }
  | { kind: "registerPushToken" | "removePushToken"; apns: string; environment: "production" | "development" }
  | { kind: "changePassword"; currentPassword: string; newPassword: string }
  | { kind: "me" | "logout" | "revokeAllSessions" | "createJoinToken" | "listHosts" };

export interface RequestCase {
  name: string;
  origin: string;
  token?: string;
  op: AccountOpDesc;
}

export const REQUEST_CASES: RequestCase[] = [
  // A stored bearer travels on every request — even login (the server
  // ignores it there).
  {
    name: "login",
    origin: `${ACCOUNT_ORIGIN}/`,
    token: "tok",
    op: { kind: "login", username: "ad min", password: "p\"w\n" },
  },
  // No token yet (the login form's own submission): no authorization header.
  { name: "login-no-token", origin: ACCOUNT_ORIGIN, op: { kind: "login", username: "u", password: "p" } },
  { name: "me", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "me" } },
  { name: "logout", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "logout" } },
  { name: "revoke-all", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "revokeAllSessions" } },
  { name: "join-token", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "createJoinToken" } },
  { name: "list-hosts", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "listHosts" } },
  // hostId goes through encodeURIComponent — space, slash, and ampersand.
  { name: "pairing-encoded-id", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "requestPairing", hostId: "id a/b&c" } },
  { name: "pairing-plain-id", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "requestPairing", hostId: HOST_ID_A } },
  // The token rides in the body, never the URL — proxy access logs keep URLs.
  {
    name: "push-token-register",
    origin: ACCOUNT_ORIGIN,
    token: "tok",
    op: { kind: "registerPushToken", apns: "ab".repeat(32), environment: "development" },
  },
  {
    name: "push-token-remove",
    origin: ACCOUNT_ORIGIN,
    token: "tok",
    op: { kind: "removePushToken", apns: "cd".repeat(32), environment: "production" },
  },
  // Both passwords ride in the body; quotes, escapes and non-ASCII must
  // serialize byte-for-byte like JSON.stringify (#450).
  {
    name: "change-password",
    origin: ACCOUNT_ORIGIN,
    token: "tok",
    op: { kind: "changePassword", currentPassword: "old \"pw\"\n", newPassword: "nouveau mot de passe é ✓" },
  },
];

export interface ResponseCase {
  name: string;
  kind: AccountOpDesc["kind"];
  status: number;
  /** The response body text; null stands for a body that never arrived (204, or a failed read). */
  body: string | null;
}

const HOST_ROW = JSON.stringify({
  hostId: HOST_ID_A,
  name: "omarchy",
  noisePublicKey: NOISE_A,
  online: true,
  lastSeenAt: 7,
  pairing: "available",
});

export const RESPONSE_CASES: ResponseCase[] = [
  { name: "login-ok-token", kind: "login", status: 200, body: '{"user":{"username":"admin"},"expiresAt":1700000000000,"token":"the-token"}' },
  // A cookie-style answer (no token) is still a valid login for the parser.
  { name: "login-ok-no-token", kind: "login", status: 200, body: '{"user":{"username":"admin"},"expiresAt":1}' },
  { name: "login-201", kind: "login", status: 201, body: '{"user":{"username":"a"},"expiresAt":2,"token":"t"}' },
  { name: "login-user-not-object", kind: "login", status: 200, body: '{"user":"x","expiresAt":1}' },
  { name: "login-missing-expiry", kind: "login", status: 200, body: '{"user":{"username":"a"}}' },
  { name: "login-null-body", kind: "login", status: 200, body: "null" },
  { name: "login-invalid-credentials", kind: "login", status: 401, body: '{"error":"invalid_credentials"}' },
  { name: "login-401-no-body", kind: "login", status: 401, body: null },
  { name: "me-ok", kind: "me", status: 200, body: '{"user":{"username":"admin"}}' },
  { name: "me-user-null", kind: "me", status: 200, body: '{"user":null}' },
  // A fully-read body that isn't JSON is still a 2xx transport-wise — the
  // endpoint's shape check turns it into invalid_response.
  { name: "me-html-200", kind: "me", status: 200, body: "<html>app</html>" },
  { name: "me-401-no-body", kind: "me", status: 401, body: null },
  { name: "me-502-html", kind: "me", status: 502, body: "<html>bad gateway</html>" },
  // Requests go out `redirect: "manual"` — a 3xx reaches us as an answer
  // and must read as a plain non-2xx failure, not a success to follow.
  { name: "me-redirect", kind: "me", status: 307, body: null },
  { name: "logout-204", kind: "logout", status: 204, body: null },
  { name: "logout-200", kind: "logout", status: 200, body: "{}" },
  { name: "revoke-204", kind: "revokeAllSessions", status: 204, body: null },
  { name: "join-ok", kind: "createJoinToken", status: 200, body: '{"token":"jt","expiresAt":9,"command":"pinomad join https://x jt"}' },
  { name: "join-missing-command", kind: "createJoinToken", status: 200, body: '{"token":"jt","expiresAt":9}' },
  { name: "hosts-ok", kind: "listHosts", status: 200, body: `[${HOST_ROW}]` },
  { name: "hosts-empty", kind: "listHosts", status: 200, body: "[]" },
  { name: "hosts-not-array", kind: "listHosts", status: 200, body: "{}" },
  { name: "hosts-bad-entry", kind: "listHosts", status: 200, body: '[{"hostId":"x"}]' },
  {
    name: "hosts-bad-pairing",
    kind: "listHosts",
    status: 200,
    body: '[{"hostId":"h","name":"n","noisePublicKey":"k","online":true,"lastSeenAt":1,"pairing":"bogus"}]',
  },
  { name: "hosts-rate-limited", kind: "listHosts", status: 429, body: '{"error":"rate_limited"}' },
  // An `error` that isn't a string doesn't become the code.
  { name: "hosts-error-not-string", kind: "listHosts", status: 503, body: '{"error":42}' },
  {
    name: "pairing-ok",
    kind: "requestPairing",
    status: 200,
    body: `{"url":"wss://relay.example.com/c/h","hostKey":"${OFFER_KEY}","secret":"${OFFER_SECRET}","expiresAt":3}`,
  },
  { name: "pairing-missing-secret", kind: "requestPairing", status: 200, body: '{"url":"wss://x","hostKey":"k","expiresAt":1}' },
  { name: "pairing-offline", kind: "requestPairing", status: 409, body: '{"error":"host_offline"}' },
  { name: "pairing-key-mismatch", kind: "requestPairing", status: 409, body: '{"error":"key_mismatch"}' },
  { name: "pairing-host-timeout", kind: "requestPairing", status: 504, body: '{"error":"host_timeout"}' },
  { name: "push-token-register-204", kind: "registerPushToken", status: 204, body: null },
  { name: "push-token-register-invalid", kind: "registerPushToken", status: 400, body: '{"error":"invalid_request"}' },
  { name: "push-token-remove-204", kind: "removePushToken", status: 204, body: null },
  { name: "push-token-remove-401", kind: "removePushToken", status: 401, body: '{"error":"unauthenticated"}' },
  { name: "change-password-204", kind: "changePassword", status: 204, body: null },
  // 403, not 401: a mistyped current password must not read as signed out.
  { name: "change-password-wrong", kind: "changePassword", status: 403, body: '{"error":"wrong_password"}' },
  { name: "change-password-weak", kind: "changePassword", status: 400, body: '{"error":"weak_password"}' },
];

export interface ProbeCase {
  name: string;
  /** null = the request itself failed (network error or timeout). */
  status: number | null;
  /** null on a 200 = the body never finished reading inside the timeout. */
  body: string | null;
}

export const PROBE_CASES: ProbeCase[] = [
  { name: "wants-session", status: 401, body: null },
  { name: "live-session", status: 200, body: '{"user":{"username":"a"}}' },
  // `typeof [] === "object"` — an array user still counts as a live session.
  { name: "user-array", status: 200, body: '{"user":[]}' },
  { name: "user-null", status: 200, body: '{"user":null}' },
  { name: "user-missing", status: 200, body: "{}" },
  { name: "user-array-200", status: 200, body: "[]" },
  { name: "html", status: 200, body: "<html>app</html>" },
  { name: "not-json", status: 200, body: "not json at all" },
  { name: "not-found", status: 404, body: null },
  { name: "accounts-disabled", status: 404, body: '{"error":"accounts_disabled"}' },
  { name: "bad-gateway", status: 502, body: null },
  { name: "forbidden", status: 403, body: null },
  { name: "redirect", status: 301, body: null },
  { name: "network", status: null, body: null },
  { name: "body-cut", status: 200, body: null },
];

export const PROBE_REQUEST_CASES: { name: string; origin: string }[] = [
  { name: "plain", origin: ACCOUNT_ORIGIN },
  { name: "trailing-slash", origin: `${ACCOUNT_ORIGIN}/` },
  { name: "trailing-slashes", origin: `${ACCOUNT_ORIGIN}///` },
];

export const SECURE_ORIGIN_CASES: { name: string; origin: string; expect: boolean }[] = [
  { name: "https", origin: ACCOUNT_ORIGIN, expect: true },
  { name: "https-port", origin: "https://relay.example.com:8443", expect: true },
  { name: "https-upper", origin: "HTTPS://RELAY.EXAMPLE.COM:443/", expect: true },
  { name: "http-remote", origin: "http://relay.example.com", expect: false },
  { name: "http-lan-ip", origin: "http://192.168.1.5:7430", expect: false },
  { name: "http-ipv4-loopback", origin: "http://127.0.0.1:7430", expect: true },
  // WHATWG normalizes every IPv4 spelling to dotted form, so `127.1` is a
  // real 127.0.0.1 — while `127.example.com` stays a domain and must not
  // pass (plaintext credentials would go to a remote host).
  { name: "http-ipv4-short-loopback", origin: "http://127.1", expect: true },
  { name: "http-ipv4-loopback-max", origin: "http://127.255.255.254", expect: true },
  { name: "http-ipv4-just-outside", origin: "http://128.0.0.1", expect: false },
  { name: "http-localhost", origin: "http://localhost:7430", expect: true },
  { name: "http-sub-localhost", origin: "http://dev.localhost:7430", expect: true },
  { name: "http-ipv6-loopback", origin: "http://[::1]:7430", expect: true },
  { name: "http-127-name", origin: "http://127.example.com", expect: false },
  { name: "http-127-subdomain", origin: "http://127.0.0.1.example.com", expect: false },
  { name: "http-localhost-domain", origin: "http://localhost.example.com", expect: false },
  // WHATWG keeps the trailing dot (`localhost.`), which matches neither the
  // bare name nor the `.localhost` suffix — refused, conservatively.
  { name: "http-localhost-trailing-dot", origin: "http://localhost.", expect: false },
  // An IPv4-mapped IPv6 literal serializes as `[::ffff:7f00:1]` — not `::1`,
  // so both parsers call it non-loopback rather than growing a mapped form.
  { name: "http-ipv6-v4-mapped", origin: "http://[::ffff:127.0.0.1]", expect: false },
  { name: "ws", origin: "ws://relay.example.com", expect: false },
  { name: "wss-not-http", origin: "wss://relay.example.com", expect: false },
  { name: "not-a-url", origin: "not a url", expect: false },
  { name: "empty", origin: "", expect: false },
];

export const NORMALIZE_ORIGIN_CASES: { name: string; origin: string; expect: string }[] = [
  { name: "trailing-slash", origin: `${ACCOUNT_ORIGIN}/`, expect: ACCOUNT_ORIGIN },
  { name: "trailing-slashes", origin: `${ACCOUNT_ORIGIN}///`, expect: ACCOUNT_ORIGIN },
  { name: "default-port", origin: "https://relay.example.com:443", expect: ACCOUNT_ORIGIN },
  { name: "custom-port", origin: "https://relay.example.com:8443", expect: "https://relay.example.com:8443" },
  { name: "http-default-port", origin: "http://127.0.0.1:80/", expect: "http://127.0.0.1" },
  { name: "http-custom-port", origin: "http://127.0.0.1:7430/", expect: "http://127.0.0.1:7430" },
  { name: "uppercase", origin: "HTTPS://RELAY.EXAMPLE.COM/", expect: ACCOUNT_ORIGIN },
  { name: "userinfo", origin: "https://user:pw@relay.example.com/", expect: ACCOUNT_ORIGIN },
  { name: "path-and-query", origin: "https://relay.example.com/p?q=1", expect: ACCOUNT_ORIGIN },
  { name: "ws-default-port", origin: "ws://relay.example.com:80/", expect: "ws://relay.example.com" },
  // Opaque origins serialize as "null", matching `new URL().origin`.
  { name: "opaque-scheme", origin: "pinomad://pair", expect: "null" },
  { name: "unparseable", origin: "not a url//", expect: "not a url" },
  { name: "empty", origin: "", expect: "" },
];

const stored = (hostKey: string, account?: { serverOrigin: string; hostId: string }): StoredHost => ({
  url: "wss://relay.example.com/c/x",
  hostKey,
  privateKey: PRIV,
  ...(account === undefined ? {} : { account }),
});

const host = (hostId: string, noisePublicKey: string, pairing: AccountHost["pairing"] = "available"): AccountHost => ({
  hostId,
  name: "omarchy",
  noisePublicKey,
  online: true,
  lastSeenAt: 1,
  pairing,
});

export interface MatchCase {
  name: string;
  origin: string;
  hosts: AccountHost[];
  stored: StoredHost[];
  /** serverOrigin + hostId entries the user's devices declined to auto-register. */
  declined?: { serverOrigin: string; hostId: string }[];
  /** false models a failed local pairing-list read, not an empty one. */
  storedRead?: boolean;
}

export const MATCH_CASES: MatchCase[] = [
  {
    name: "linked-paired",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, STORE_KEY_A)],
    // The stored link survives a non-normalized serverOrigin.
    stored: [stored(STORE_KEY_A, { serverOrigin: `${ACCOUNT_ORIGIN}/`, hostId: HOST_ID_A })],
  },
  {
    name: "twin-linkable",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, STORE_KEY_B)],
    stored: [stored(STORE_KEY_B)],
  },
  {
    name: "unpaired",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_C)],
    stored: [stored(STORE_KEY_B)],
  },
  {
    name: "key-changed",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_ROTATED)],
    stored: [stored(STORE_KEY_C, { serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A })],
  },
  {
    // A re-pair after a key change stores a fresh record; the entry whose
    // key still matches wins over the stale link.
    name: "stale-and-fresh-link",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, STORE_KEY_E)],
    stored: [
      stored(STORE_KEY_D, { serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A }),
      stored(STORE_KEY_E, { serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A }),
    ],
  },
  {
    // No linked key matches → key_changed reports the first linked entry,
    // even when an unlinked twin shares the host's current key.
    name: "linked-shadows-twin",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, STORE_KEY_F)],
    stored: [
      stored(STORE_KEY_C, { serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A }),
      stored(STORE_KEY_F),
    ],
  },
  {
    // A link for another origin doesn't pair — and the twin check still
    // finds it by key, reporting paired-but-not-linkable.
    name: "other-origin-same-key",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, STORE_KEY_C)],
    stored: [stored(STORE_KEY_C, { serverOrigin: "https://other.example.com", hostId: HOST_ID_A })],
  },
  {
    name: "other-origin-other-key",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_B)],
    stored: [stored(STORE_KEY_C, { serverOrigin: "https://other.example.com", hostId: HOST_ID_A })],
  },
  {
    name: "origin-normalizes",
    origin: "https://relay.example.com:443/",
    hosts: [host(HOST_ID_A, STORE_KEY_A)],
    stored: [stored(STORE_KEY_A, { serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A })],
  },
  {
    name: "host-offline-row",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_B, NOISE_B, "offline")],
    stored: [],
    // Eligibility only asks about trust and the read; the attempt itself may
    // still fail because the host is offline.
    storedRead: true,
  },
  {
    name: "unpaired-declined",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_C)],
    stored: [],
    declined: [{ serverOrigin: `${ACCOUNT_ORIGIN}/`, hostId: HOST_ID_A }],
  },
  {
    name: "declined-other-origin",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_C)],
    stored: [],
    declined: [{ serverOrigin: "https://other.example.com", hostId: HOST_ID_A }],
  },
  {
    name: "key-changed-declined",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_ROTATED)],
    stored: [stored(STORE_KEY_C, { serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A })],
    declined: [{ serverOrigin: ACCOUNT_ORIGIN, hostId: HOST_ID_A }],
  },
  {
    name: "stored-read-failed",
    origin: ACCOUNT_ORIGIN,
    hosts: [host(HOST_ID_A, NOISE_C)],
    stored: [],
    storedRead: false,
  },
];

export interface OfferCase {
  name: string;
  offer: PairingOffer;
}

export const OFFER_CASES: OfferCase[] = [
  {
    name: "valid",
    offer: { url: "wss://relay.example.com/c/host", hostKey: OFFER_KEY, secret: OFFER_SECRET, expiresAt: 1 },
  },
  { name: "url-with-port", offer: { url: "wss://relay.example.com:8443/c/h", hostKey: OFFER_KEY, secret: OFFER_SECRET, expiresAt: 1 } },
  // An offer the pairing-link rule refuses: a non-socket url or a malformed
  // pair param must not reach the handshake.
  { name: "url-not-socket", offer: { url: "https://evil.example.com", hostKey: OFFER_KEY, secret: OFFER_SECRET, expiresAt: 1 } },
  { name: "host-key-short", offer: { url: "wss://x", hostKey: "short", secret: OFFER_SECRET, expiresAt: 1 } },
  { name: "secret-empty", offer: { url: "wss://x", hostKey: OFFER_KEY, secret: "", expiresAt: 1 } },
  // `+` decodes as a space in form data — a bad secret still fails cleanly.
  { name: "secret-not-base64url", offer: { url: "wss://x", hostKey: OFFER_KEY, secret: "not+base64url/===", expiresAt: 1 } },
];
