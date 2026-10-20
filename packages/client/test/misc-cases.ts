// Shared inputs for the small standalone derivations: questions, folder
// paths, stored hosts, provider-failure classification. The vitest suite and
// packages/client/test/rust-vectors.ts both consume these tables.
import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import type { StoredHost } from "../src/stored-host.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";

// Deterministic keys for the stored-host vectors (the random generateKeyPair
// the test uses can't be committed as ground truth).
export const KEY_A = toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(1)).privateKey);
export const KEY_B = toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(2)).privateKey);
export const KEY_C = toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(6)).privateKey);
export const HOST_KEY_A = toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(3)).publicKey);
export const HOST_KEY_B = toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(4)).publicKey);
export const HOST_KEY_C = toBase64Url(keyPairFromPrivate(new Uint8Array(32).fill(5)).publicKey);

const request = (id: string, resolution?: object) => ({
  id,
  askedAt: 1,
  questions: [{ header: "H", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
  ...(resolution === undefined ? {} : { resolution }),
});

export const PENDING_QUESTION_CASES = [
  {
    name: "mixed-docs",
    docs: [
      { kind: "question", presentation: "pinomad.question", value: { requests: [request("r1", { outcome: "answered", answers: [], at: 1 }), request("r2")] } },
      { kind: "todo", value: { items: [] } },
      { kind: "question", presentation: "pinomad.question", value: { requests: [request("r3")] } },
    ],
  },
  {
    name: "doc-order",
    docs: [
      { kind: "a", presentation: "pinomad.question", value: { requests: [request("first")] } },
      { kind: "question", presentation: "pinomad.question", value: { requests: [request("second")] } },
    ],
  },
  {
    name: "non-question-value",
    docs: [{ kind: "question", presentation: "pinomad.question", value: { not: "a question" } }],
  },
  { name: "empty", docs: [] },
];

export const ANSWER_CASES: { name: string; questionCount: number; selections: string[][]; others: string[] }[] = [
  { name: "blank-and-custom", questionCount: 2, selections: [["A"], ["B"]], others: ["  ", "custom"] },
  { name: "untouched", questionCount: 2, selections: [[], []], others: ["", ""] },
  { name: "missing-slots", questionCount: 3, selections: [["A"]], others: [] },
];

export const CRUMB_CASES = [
  { name: "under-home", path: "/Users/v/code/x", home: "/Users/v" },
  { name: "at-home", path: "/Users/v", home: "/Users/v" },
  { name: "outside-home", path: "/srv/app", home: "/Users/v" },
  { name: "root", path: "/", home: "/Users/v" },
  { name: "shared-prefix", path: "/Users/vx", home: "/Users/v" },
  { name: "home-is-root", path: "/srv", home: "/" },
  { name: "trailing-slashes", path: "/a//b/", home: "/" },
  { name: "non-bmp", path: "/srv/\u{1F4C1}/x", home: "/" },
];

export const PARENT_FOLDER_CASES = [
  { name: "nested", path: "/a/b" },
  { name: "top", path: "/a" },
  { name: "root", path: "/" },
];

const valid = () => ({ url: "ws://192.168.1.5:7422/secure", hostKey: KEY_A, privateKey: KEY_B });

export const HOST_CASES: { name: string; value: unknown }[] = [
  { name: "valid", value: valid() },
  { name: "wss", value: { ...valid(), url: "wss://relay.example.com/c/host" } },
  { name: "named", value: { ...valid(), name: "Workstation" } },
  { name: "name-nonstring", value: { ...valid(), name: 42 } },
  { name: "name-empty", value: { ...valid(), name: "" } },
  { name: "extra-fields", value: { ...valid(), unknownField: "x", nested: { x: 1 } } },
  { name: "account", value: { ...valid(), account: { serverOrigin: "https://relay.example.com", hostId: HOST_KEY_A } } },
  { name: "account-missing-hostid", value: { ...valid(), account: { serverOrigin: "https://x" } } },
  { name: "account-short-key", value: { ...valid(), account: { serverOrigin: "https://x", hostId: "short" } } },
  { name: "account-junk", value: { ...valid(), account: "junk" } },
  { name: "account-number", value: { ...valid(), account: 42 } },
  { name: "account-empty-origin", value: { ...valid(), account: { serverOrigin: "", hostId: HOST_KEY_A } } },
  { name: "http-url", value: { ...valid(), url: "http://localhost:5199/" } },
  { name: "https-url", value: { ...valid(), url: "https://example.com" } },
  { name: "not-a-url", value: { ...valid(), url: "not a url" } },
  { name: "number-url", value: { ...valid(), url: 42 } },
  { name: "key-31-bytes", value: { ...valid(), hostKey: toBase64Url(new Uint8Array(31)) } },
  { name: "key-not-base64url", value: { ...valid(), privateKey: "not+base64url/===" } },
  { name: "non-object-undefined", value: undefined },
  { name: "non-object-null", value: null },
  { name: "non-object-string", value: "ws://x" },
  { name: "non-object-number", value: 42 },
  { name: "non-object-array", value: ["a"] },
  { name: "ws-default-port", value: { ...valid(), url: "ws://example.com:80/x" } },
  { name: "url-path-only", value: { ...valid(), url: "ws:opaque" } },
];

const storedA = { url: "ws://10.0.0.2:7422", hostKey: HOST_KEY_A, privateKey: KEY_A };
const storedB = { url: "ws://10.0.0.3:7422", hostKey: HOST_KEY_B, privateKey: KEY_B };
const relayA = { url: "wss://relay.example.com/c/host-a", hostKey: HOST_KEY_A, privateKey: KEY_A };
const relayB = { url: "wss://relay.example.com/c/host-b", hostKey: HOST_KEY_B, privateKey: KEY_B };

export const HOST_LABEL_CASES: { name: string; hosts: StoredHost[] }[] = [
  { name: "distinct", hosts: [storedA, storedB] },
  { name: "shared-relay", hosts: [relayA, relayB] },
  { name: "mixed", hosts: [relayA, relayB, storedA] },
  { name: "bad-url-fallback", hosts: [{ url: "not a url", hostKey: HOST_KEY_A, privateKey: KEY_A }] },
  // The stored name beats the URL host (5.12): it is the machine's name.
  { name: "named", hosts: [{ ...storedA, name: "Desk" }, storedB] },
  { name: "named-relay", hosts: [{ ...relayA, name: "Desk" }, relayB] },
  { name: "same-name", hosts: [{ ...storedA, name: "Desk" }, { ...storedB, name: "Desk" }] },
  // A name may be stored under a different URL — collision rules apply to the
  // final label, so "Desk · <key>" colliding with a real name lengthens.
  {
    name: "name-shadows-disambiguation",
    hosts: [
      { ...storedA, name: "Desk" },
      { ...storedB, name: "Desk" },
      { url: "ws://10.0.0.4:7422", hostKey: HOST_KEY_C, privateKey: KEY_C, name: `Desk · ${HOST_KEY_A.slice(0, 6)}` },
    ],
  },
  { name: "name-and-url-collide", hosts: [{ ...storedA, name: "10.0.0.3:7422" }, storedB] },
];

export const FAILURE_CASES: { name: string; error: unknown }[] = [
  { name: "status-401", error: { status: 401, message: "Unauthorized" } },
  { name: "status-403-prose", error: { status: 403, message: "unauthorized" } },
  { name: "metadata-401", error: { $metadata: { httpStatusCode: 401 }, message: "rejected" } },
  { name: "response-403", error: { $response: { statusCode: 403 } } },
  { name: "statusCode-field", error: { statusCode: 401 } },
  { name: "401-in-message", error: { message: "HTTP 401 unauthorized" } },
  { name: "403-in-message", error: { message: "got a 403 back" } },
  // \b401\b / \b403\b: a word char on either side is no boundary.
  { name: "401-inside-word", error: { message: "code 4017 weird" } },
  { name: "403-inside-word", error: { message: "code x403 weird" } },
  { name: "plan", error: { message: "plan limit reached" } },
  { name: "subscription", error: { message: "Your subscription lapsed" } },
  { name: "entitlement-word", error: { message: "missing entitlement" } },
  // \b(?:plan|subscription|entitlement)\b negatives.
  { name: "planet", error: { message: "this planet is large" } },
  { name: "subscriptions", error: { message: "many subscriptions active" } },
  { name: "network-code", error: { code: "ECONNREFUSED", message: "connect failed" } },
  { name: "network-code-und", error: { code: "UND_ERR_SOCKET", message: "socket" } },
  { name: "nested-cause", error: { message: "wrapper", cause: { code: "ETIMEDOUT" } },
  },
  // RESOLVED_NETWORK_MESSAGE — one hit per alternative; `.?` alternatives
  // get a hit with the optional char and one without.
  { name: "fetch-failed", error: { message: "TypeError: fetch failed" } },
  { name: "oauth-refresh-fetch", error: { message: "OAuth refresh failed for x: fetch failed" } },
  { name: "network-error", error: { message: "network error" } },
  { name: "networkerror", error: { message: "networkerror" } },
  { name: "connection-error", error: { message: "connection error" } },
  { name: "connectionerror", error: { message: "connectionerror" } },
  { name: "connection-refused", error: { message: "connection refused" } },
  { name: "connectionrefused", error: { message: "connectionrefused" } },
  { name: "connection-lost", error: { message: "connection lost" } },
  { name: "connectionlost", error: { message: "connectionlost" } },
  { name: "other-side-closed", error: { message: "other side closed" } },
  { name: "getaddrinfo", error: { message: "getaddrinfo ENOTFOUND api.example.com" } },
  { name: "enotfound", error: { message: "ENOTFOUND host" } },
  { name: "eai-again", error: { message: "EAI_AGAIN dns" } },
  { name: "upstream-connect", error: { message: "upstream connect failed" } },
  { name: "upstreamconnect", error: { message: "upstreamconnect failed" } },
  { name: "reset-before-headers", error: { message: "reset before headers" } },
  { name: "socket-hang-up", error: "socket hang up" },
  { name: "socket-closed", error: { message: "socket connection was closed" } },
  { name: "timed-out", error: { message: "Request timed out." } },
  { name: "time-out", error: { message: "Request time out." } },
  // `timed? out` — d optional, space mandatory; "timedout" must not match.
  { name: "timedout", error: { message: "timedout" } },
  // The OAuth prose also matches, but network runs first.
  { name: "oauth-refresh-timeout", error: { message: "OAuth refresh failed: request time out" } },
  { name: "timeout-word", error: { message: "connection timeout" } },
  { name: "terminated", error: { message: "connection terminated" } },
  { name: "websocket-closed", error: { message: "websocket closed by peer" } },
  { name: "websocketclosed", error: { message: "websocketclosed" } },
  { name: "websocket-error", error: { message: "websocket error" } },
  { name: "websocketerror", error: { message: "websocketerror" } },
  { name: "ended-without", error: { message: "stream ended without response" } },
  { name: "message-stop", error: { message: "stream ended before message_stop" } },
  { name: "terminal-event", error: { message: "stream ended before a terminal response event" } },
  { name: "http2-no-response", error: { message: "http2 request did not get a response" } },
  { name: "econnrefused", error: { message: "ECONNREFUSED" } },
  { name: "etimedout", error: { message: "ETIMEDOUT" } },
  { name: "econnreset", error: { message: "ECONNRESET" } },
  { name: "und-err", error: { message: "UND_ERR_CONNECT_TIMEOUT" } },
  // Auth prose — invalid.?api.?key gets middle-char, no-char, and spaced hits.
  { name: "invalid-api-key", error: { message: "invalid api key provided" } },
  { name: "invalidapikey", error: { message: "invalidapikey" } },
  { name: "invalid-dash-key", error: { message: "invalid-api-key" } },
  { name: "authentication-error", error: { message: "authentication_error" } },
  { name: "invalid_grant", error: { message: "invalid_grant: token expired" } },
  { name: "oauth-refresh-failed", error: { message: "OAuth refresh failed for x" } },
  { name: "unauthorized", error: { message: "request unauthorized" } },
  { name: "refresh-token", error: { message: "bad refresh token" } },
  { name: "refreshtoken", error: { message: "bad refreshtoken" } },
  { name: "refresh-dash-token", error: { message: "bad refresh-token" } },
  {
    name: "deep-cause",
    error: {
      message: "a",
      cause: { message: "b", cause: { message: "c", cause: { message: "d", cause: { message: "e", cause: { code: "ECONNRESET" } } } } },
    },
  },
  { name: "number-error", error: 5 },
  { name: "unknown-message", error: { message: "Something odd happened" } },
  { name: "null-error", error: null },
];
