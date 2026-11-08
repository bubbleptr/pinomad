// Shared inputs for the account-client vectors (packages/client/test/
// rust-vectors.ts): request shapes, canned responses, probe verdicts, the
// origin rules, host matching, and pairing offers. Values are deterministic
// — the committed fixtures are ground truth the Rust side replays.
import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { AccountDeviceClaim, AccountHost, PairingOffer } from "../src/account.ts";
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

/**
 * A confirmation as the cases spell it (ADR-0044 §6): `password` for the
 * password, `reauth` for a grant — exactly one of them.
 */
export type ConfirmationDesc = { password: string; reauth?: never } | { reauth: string; password?: never };

export type AccountOpDesc =
  | { kind: "login"; username: string; password: string; device?: AccountDeviceClaim }
  | { kind: "requestPairing"; hostId: string }
  | { kind: "registerPushToken" | "removePushToken"; apns: string; environment: "production" | "development" }
  | ({ kind: "changePassword"; newPassword: string } & ({ currentPassword: string; reauth?: never } | { reauth: string; currentPassword?: never }))
  | ({ kind: "deleteAccount" } & ConfirmationDesc)
  | ({ kind: "kickDevice"; id: number } & ConfirmationDesc)
  | ({ kind: "removeHost"; hostId: string } & ConfirmationDesc)
  | { kind: "logout"; revoke?: boolean }
  | { kind: "lookupHostLink" | "confirmHostLink" | "denyHostLink"; userCode: string }
  | { kind: "lookupHostLinkRequest" | "confirmHostLinkRequest" | "denyHostLinkRequest"; requestId: string }
  | { kind: "me" | "revokeAllSessions" | "createJoinToken" | "listHosts" | "listDevices" }
  | { kind: "authMethods" | "identities" | "requestReauthCode" }
  | { kind: "requestSignupCode" | "requestPasswordReset"; email: string }
  | { kind: "register"; email: string; code: string; password: string; device?: AccountDeviceClaim }
  | { kind: "resetPassword"; email: string; code: string; password: string }
  | ({ kind: "requestEmailCode"; email: string } & ConfirmationDesc)
  | ({ kind: "setEmail"; email: string; code: string } & ConfirmationDesc)
  | ({ kind: "unlinkProvider"; provider: string } & ConfirmationDesc)
  | { kind: "reauth"; password: string; code?: never }
  | { kind: "reauth"; code: string; password?: never }
  | { kind: "pendingSignIn"; id: string }
  | { kind: "createFromPending"; id: string; password?: string; device?: AccountDeviceClaim }
  | ({ kind: "linkPending"; id: string } & ConfirmationDesc)
  | { kind: "exchangeOAuthCode"; code: string; codeVerifier: string; device?: AccountDeviceClaim }
  | ({ kind: "linkProvider"; provider: string; native?: { redirectUri: string; codeChallenge: string; state: string } } & ConfirmationDesc)
  | ({ kind: "linkAppleNative"; identityToken: string; authorizationCode: string; nonce?: string; name?: string } & ConfirmationDesc)
  | {
      kind: "appleNative";
      identityToken: string;
      authorizationCode: string;
      nonce?: string;
      name?: string;
      device?: AccountDeviceClaim;
    };

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
  // The device claim rides after the credentials (ADR-0037 §1); a nameless one
  // carries only its id, and a name keeps its non-ASCII bytes.
  {
    name: "login-device",
    origin: ACCOUNT_ORIGIN,
    op: { kind: "login", username: "u", password: "p", device: { id: "Qm3xV8rT2kLp9wYz4nHc1A", name: "Kieran's iPhone \u2014 \u00e9" } },
  },
  {
    name: "login-device-unnamed",
    origin: ACCOUNT_ORIGIN,
    op: { kind: "login", username: "u", password: "p", device: { id: "Qm3xV8rT2kLp9wYz4nHc1A" } },
  },
  { name: "me", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "me" } },
  { name: "logout", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "logout" } },
  // Only a revoking sign-out carries a body (#494); `revoke: false` is the
  // plain request, byte for byte.
  { name: "logout-revoke", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "logout", revoke: true } },
  { name: "logout-no-revoke", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "logout", revoke: false } },
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
  // The password again, escaped like any body string (#451).
  { name: "delete-account", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "deleteAccount", password: "pw \"q\"\\\t✓" } },
  { name: "list-devices", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "listDevices" } },
  // The server's numeric id goes into the path as `${id}` (#452).
  { name: "kick-device", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "kickDevice", id: 1234, password: "pé \"x\"\n" } },
  // The hostId goes through encodeURIComponent like requestPairing's (#512).
  { name: "remove-host", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "removeHost", hostId: "h/1+é", password: "pw \"q\"" } },
  // Host links (#495): the code goes as typed — case, dashes and spaces are
  // the server's to ignore, and quotes still escape like any body string.
  { name: "host-link-lookup", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "lookupHostLink", userCode: "wdjb-MJHT" } },
  { name: "host-link-confirm", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "confirmHostLink", userCode: "WDJB MJHT" } },
  { name: "host-link-deny", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "denyHostLink", userCode: "W\"DJB\n" } },
  // Loopback host links (#513): the request id from the confirm URL, as given.
  { name: "host-link-request-lookup", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "lookupHostLinkRequest", requestId: "r".repeat(43) } },
  { name: "host-link-request-confirm", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "confirmHostLinkRequest", requestId: "r\"q" } },
  { name: "host-link-request-deny", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "denyHostLinkRequest", requestId: "r" } },
  // A grant stands in for the password on every confirmed action (ADR-0044
  // §6); a password change names it `reauth` beside the new password, which
  // also sets a first password on an account without one.
  { name: "change-password-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "changePassword", reauth: "g\"1", newPassword: "first password ✓" } },
  { name: "delete-account-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "deleteAccount", reauth: "grant" } },
  { name: "kick-device-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "kickDevice", id: 7, reauth: "grant" } },
  { name: "remove-host-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "removeHost", hostId: HOST_ID_A, reauth: "grant" } },
  // Email accounts (ADR-0044): codes and addresses go as typed.
  { name: "auth-methods", origin: `${ACCOUNT_ORIGIN}/`, op: { kind: "authMethods" } },
  { name: "signup-code", origin: ACCOUNT_ORIGIN, op: { kind: "requestSignupCode", email: "Ann@Example.com" } },
  {
    name: "register",
    origin: ACCOUNT_ORIGIN,
    op: { kind: "register", email: "a@b.co", code: "012345", password: "p \"w\" é", device: { id: "Qm3xV8rT2kLp9wYz4nHc1A", name: "iPhone" } },
  },
  { name: "register-no-device", origin: ACCOUNT_ORIGIN, op: { kind: "register", email: "a@b.co", code: "1", password: "p" } },
  { name: "reset-code", origin: ACCOUNT_ORIGIN, op: { kind: "requestPasswordReset", email: "a@b.co" } },
  { name: "reset-password", origin: ACCOUNT_ORIGIN, op: { kind: "resetPassword", email: "a@b.co", code: "999999", password: "new pw" } },
  { name: "email-code-password", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "requestEmailCode", email: "new@b.co", password: "pw" } },
  { name: "email-code-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "requestEmailCode", email: "new@b.co", reauth: "grant" } },
  { name: "set-email-password", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "setEmail", email: "new@b.co", code: "123456", password: "pw" } },
  { name: "set-email-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "setEmail", email: "new@b.co", code: "123456", reauth: "grant" } },
  // Sign-in methods and re-auth (ADR-0044 §4, §6).
  { name: "identities", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "identities" } },
  { name: "unlink-provider", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "unlinkProvider", provider: "git hub/é", password: "pw" } },
  { name: "unlink-provider-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "unlinkProvider", provider: "apple", reauth: "grant" } },
  // An empty object, not no body: the server reads JSON here.
  { name: "reauth-code", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "requestReauthCode" } },
  { name: "reauth-password", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "reauth", password: "pw \"q\"" } },
  { name: "reauth-code-proof", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "reauth", code: "123456" } },
  // The pending "no account yet" sign-in: the id goes through encodeURIComponent.
  { name: "pending-sign-in", origin: ACCOUNT_ORIGIN, op: { kind: "pendingSignIn", id: "p".repeat(43) } },
  { name: "create-from-pending", origin: ACCOUNT_ORIGIN, op: { kind: "createFromPending", id: "a/b" } },
  {
    name: "create-from-pending-password",
    origin: ACCOUNT_ORIGIN,
    op: { kind: "createFromPending", id: "p".repeat(43), password: "pw é", device: { id: "Qm3xV8rT2kLp9wYz4nHc1A" } },
  },
  { name: "link-pending-password", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "linkPending", id: "p".repeat(43), password: "pw" } },
  { name: "link-pending-reauth", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "linkPending", id: "p".repeat(43), reauth: "grant" } },
  // A native app's code exchange and iOS's own Apple sign-in (ADR-0044 §5).
  {
    name: "exchange-oauth-code",
    origin: ACCOUNT_ORIGIN,
    op: { kind: "exchangeOAuthCode", code: "c0de", codeVerifier: "v".repeat(43), device: { id: "Qm3xV8rT2kLp9wYz4nHc1A", name: "iPhone" } },
  },
  { name: "exchange-oauth-code-no-device", origin: ACCOUNT_ORIGIN, op: { kind: "exchangeOAuthCode", code: "c", codeVerifier: "v".repeat(43) } },
  {
    name: "apple-native",
    origin: ACCOUNT_ORIGIN,
    op: {
      kind: "appleNative",
      identityToken: "eyJ.id.tok",
      authorizationCode: "ac",
      nonce: "raw-nonce",
      name: "Ann Lee",
      device: { id: "Qm3xV8rT2kLp9wYz4nHc1A", name: "iPhone" },
    },
  },
  { name: "apple-native-bare", origin: ACCOUNT_ORIGIN, op: { kind: "appleNative", identityToken: "t", authorizationCode: "c" } },
  // Linking from settings (#631): the web's bare confirmation, and a native
  // app's redirect after it.
  { name: "link-provider", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "linkProvider", provider: "git hub/é", password: "pw" } },
  {
    name: "link-provider-native",
    origin: ACCOUNT_ORIGIN,
    token: "tok",
    op: {
      kind: "linkProvider",
      provider: "google",
      reauth: "grant",
      native: { redirectUri: "pinomad://auth", codeChallenge: "c".repeat(43), state: "st" },
    },
  },
  {
    name: "link-apple-native",
    origin: ACCOUNT_ORIGIN,
    token: "tok",
    op: { kind: "linkAppleNative", identityToken: "eyJ.id.tok", authorizationCode: "ac", nonce: "raw-nonce", name: "Ann Lee", reauth: "grant" },
  },
  { name: "link-apple-native-bare", origin: ACCOUNT_ORIGIN, token: "tok", op: { kind: "linkAppleNative", identityToken: "t", authorizationCode: "c", password: "pw" } },
];

export interface ResponseCase {
  name: string;
  kind: AccountOpDesc["kind"];
  status: number;
  /** The response body text; null stands for a body that never arrived (204, or a failed read). */
  body: string | null;
}

const DEVICE_ROWS = JSON.stringify([
  {
    id: 3,
    name: "iPhone",
    createdAt: 1,
    lastSeenAt: 5,
    current: true,
    hosts: [
      { hostId: "h1", name: "omarchy", state: "registered" },
      { hostId: "h2", name: "studio", state: "revoking" },
    ],
  },
  // Nameless (a client from before #452) and removed, revoked on its one host.
  { id: 2, createdAt: 1, lastSeenAt: 2, current: false, kickedAt: 4, hosts: [{ hostId: "h1", name: "omarchy", state: "revoked" }] },
]);

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
  // An email account (ADR-0044): the email rides beside the shown name.
  { name: "login-email", kind: "login", status: 200, body: '{"user":{"username":"a@b.co","email":"a@b.co"},"expiresAt":1,"token":"t"}' },
  // `needsEmail` counts only as `true`, and a non-string email is dropped (ADR-0044 §8).
  { name: "login-needs-email", kind: "login", status: 200, body: '{"user":{"username":"kieran"},"needsEmail":true,"expiresAt":1,"token":"t"}' },
  { name: "login-loose-email-fields", kind: "login", status: 200, body: '{"user":{"username":"a","email":7},"needsEmail":"yes","expiresAt":1,"token":"t"}' },
  { name: "login-201", kind: "login", status: 201, body: '{"user":{"username":"a"},"expiresAt":2,"token":"t"}' },
  { name: "login-user-not-object", kind: "login", status: 200, body: '{"user":"x","expiresAt":1}' },
  { name: "login-missing-expiry", kind: "login", status: 200, body: '{"user":{"username":"a"}}' },
  { name: "login-null-body", kind: "login", status: 200, body: "null" },
  { name: "login-invalid-credentials", kind: "login", status: 401, body: '{"error":"invalid_credentials"}' },
  { name: "login-401-no-body", kind: "login", status: 401, body: null },
  { name: "me-ok", kind: "me", status: 200, body: '{"user":{"username":"admin"}}' },
  { name: "me-email", kind: "me", status: 200, body: '{"user":{"username":"a@b.co","email":"a@b.co"}}' },
  { name: "me-needs-email", kind: "me", status: 200, body: '{"user":{"username":"kieran"},"needsEmail":true}' },
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
  // deviceReports is additive (#452): a boolean passes through, anything else is malformed.
  { name: "hosts-device-reports", kind: "listHosts", status: 200, body: `[${HOST_ROW.slice(0, -1)},"deviceReports":false}]` },
  {
    name: "hosts-device-reports-bad",
    kind: "listHosts",
    status: 200,
    body: `[${HOST_ROW.slice(0, -1)},"deviceReports":"no"}]`,
  },
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
  // Deleting the account: the 403 is a refusal, not a sign-out (#451).
  { name: "delete-account-204", kind: "deleteAccount", status: 204, body: null },
  { name: "delete-account-wrong", kind: "deleteAccount", status: 403, body: '{"error":"wrong_password"}' },
  { name: "delete-account-rate-limited", kind: "deleteAccount", status: 429, body: '{"error":"rate_limited"}' },
  { name: "delete-account-401", kind: "deleteAccount", status: 401, body: '{"error":"unauthenticated"}' },
  // The device list (#452): every host state, a nameless and a removed row.
  { name: "devices-ok", kind: "listDevices", status: 200, body: DEVICE_ROWS },
  { name: "devices-empty", kind: "listDevices", status: 200, body: "[]" },
  { name: "devices-not-array", kind: "listDevices", status: 200, body: "{}" },
  { name: "devices-id-string", kind: "listDevices", status: 200, body: '[{"id":"1","createdAt":1,"lastSeenAt":1,"current":false,"hosts":[]}]' },
  {
    name: "devices-name-number",
    kind: "listDevices",
    status: 200,
    body: '[{"id":1,"name":4,"createdAt":1,"lastSeenAt":1,"current":false,"hosts":[]}]',
  },
  {
    name: "devices-kicked-string",
    kind: "listDevices",
    status: 200,
    body: '[{"id":1,"createdAt":1,"lastSeenAt":1,"current":false,"kickedAt":"x","hosts":[]}]',
  },
  {
    name: "devices-bad-state",
    kind: "listDevices",
    status: 200,
    body: '[{"id":1,"createdAt":1,"lastSeenAt":1,"current":false,"hosts":[{"hostId":"h","name":"n","state":"gone"}]}]',
  },
  // Servers from before #452 have no device list.
  { name: "devices-404", kind: "listDevices", status: 404, body: '{"error":"not_found"}' },
  { name: "kick-204", kind: "kickDevice", status: 204, body: null },
  { name: "kick-wrong", kind: "kickDevice", status: 403, body: '{"error":"wrong_password"}' },
  { name: "kick-current", kind: "kickDevice", status: 409, body: '{"error":"current_device"}' },
  { name: "kick-not-found", kind: "kickDevice", status: 404, body: '{"error":"not_found"}' },
  { name: "kick-rate-limited", kind: "kickDevice", status: 429, body: '{"error":"rate_limited"}' },
  { name: "remove-host-204", kind: "removeHost", status: 204, body: null },
  { name: "remove-host-wrong", kind: "removeHost", status: 403, body: '{"error":"wrong_password"}' },
  { name: "remove-host-not-found", kind: "removeHost", status: 404, body: '{"error":"not_found"}' },
  { name: "remove-host-rate-limited", kind: "removeHost", status: 429, body: '{"error":"rate_limited"}' },
  // The host waiting behind a code (#495): every field required, ipDiffers a real boolean.
  {
    name: "host-link-lookup-ok",
    kind: "lookupHostLink",
    status: 200,
    body: `{"hostId":"${HOST_ID_A}","name":"omarchy — é","os":"Linux (x64)","sourceIp":"203.0.113.7","ipDiffers":true,"expiresAt":9}`,
  },
  {
    name: "host-link-lookup-same-ip",
    kind: "lookupHostLink",
    status: 200,
    body: `{"hostId":"${HOST_ID_A}","name":"mbp","os":"macOS (arm64)","sourceIp":"::1","ipDiffers":false,"expiresAt":1,"extra":1}`,
  },
  {
    name: "host-link-lookup-ip-differs-string",
    kind: "lookupHostLink",
    status: 200,
    body: `{"hostId":"h","name":"n","os":"o","sourceIp":"i","ipDiffers":"yes","expiresAt":1}`,
  },
  { name: "host-link-lookup-missing-os", kind: "lookupHostLink", status: 200, body: `{"hostId":"h","name":"n","sourceIp":"i","ipDiffers":true,"expiresAt":1}` },
  { name: "host-link-lookup-not-found", kind: "lookupHostLink", status: 404, body: '{"error":"not_found"}' },
  { name: "host-link-lookup-limited", kind: "lookupHostLink", status: 429, body: '{"error":"rate_limited"}' },
  { name: "host-link-confirm-204", kind: "confirmHostLink", status: 204, body: null },
  { name: "host-link-confirm-not-found", kind: "confirmHostLink", status: 404, body: '{"error":"not_found"}' },
  { name: "host-link-confirm-401", kind: "confirmHostLink", status: 401, body: null },
  { name: "host-link-deny-204", kind: "denyHostLink", status: 204, body: null },
  { name: "host-link-deny-limited", kind: "denyHostLink", status: 429, body: '{"error":"rate_limited"}' },
  {
    name: "host-link-request-lookup-ok",
    kind: "lookupHostLinkRequest",
    status: 200,
    body: `{"hostId":"${HOST_ID_A}","name":"mbp","os":"macOS (arm64)","sourceIp":"127.0.0.1","ipDiffers":false,"expiresAt":9}`,
  },
  { name: "host-link-request-lookup-not-found", kind: "lookupHostLinkRequest", status: 404, body: '{"error":"not_found"}' },
  // Only a redirect to this machine's 127.0.0.1 over http is taken (#513).
  {
    name: "host-link-request-confirm-ok",
    kind: "confirmHostLinkRequest",
    status: 200,
    body: '{"redirect":"http://127.0.0.1:54321/callback?code=c0de&state=st"}',
  },
  { name: "host-link-request-confirm-elsewhere", kind: "confirmHostLinkRequest", status: 200, body: '{"redirect":"https://evil.example/cb?code=c"}' },
  { name: "host-link-request-confirm-localhost", kind: "confirmHostLinkRequest", status: 200, body: '{"redirect":"http://localhost:54321/cb"}' },
  { name: "host-link-request-confirm-no-port", kind: "confirmHostLinkRequest", status: 200, body: '{"redirect":"http://127.0.0.1/cb"}' },
  { name: "host-link-request-confirm-not-url", kind: "confirmHostLinkRequest", status: 200, body: '{"redirect":"nope"}' },
  { name: "host-link-request-confirm-204", kind: "confirmHostLinkRequest", status: 204, body: null },
  { name: "host-link-request-confirm-not-found", kind: "confirmHostLinkRequest", status: 404, body: '{"error":"not_found"}' },
  {
    name: "host-link-request-deny-ok",
    kind: "denyHostLinkRequest",
    status: 200,
    body: '{"redirect":"http://127.0.0.1:54321/callback?error=access_denied&state=st"}',
  },
  // A grant that lapsed or belongs to another session is a refusal, not a sign-out.
  { name: "delete-account-invalid-reauth", kind: "deleteAccount", status: 403, body: '{"error":"invalid_reauth"}' },
  { name: "auth-methods-ok", kind: "authMethods", status: 200, body: '{"registration":true,"email":false,"providers":["google","apple"],"extra":1}' },
  { name: "auth-methods-none", kind: "authMethods", status: 200, body: '{"registration":false,"email":true,"providers":[]}' },
  { name: "auth-methods-bad-provider", kind: "authMethods", status: 200, body: '{"registration":true,"email":true,"providers":["google",1]}' },
  { name: "auth-methods-email-string", kind: "authMethods", status: 200, body: '{"registration":true,"email":"yes","providers":[]}' },
  { name: "auth-methods-404", kind: "authMethods", status: 404, body: '{"error":"not_found"}' },
  { name: "signup-code-204", kind: "requestSignupCode", status: 204, body: null },
  { name: "signup-code-closed", kind: "requestSignupCode", status: 403, body: '{"error":"registration_closed"}' },
  { name: "register-ok", kind: "register", status: 200, body: '{"user":{"username":"a@b.co","email":"a@b.co"},"expiresAt":5,"token":"t"}' },
  { name: "register-invalid-code", kind: "register", status: 400, body: '{"error":"invalid_code"}' },
  { name: "register-missing-expiry", kind: "register", status: 200, body: '{"user":{"username":"a@b.co"},"token":"t"}' },
  { name: "reset-code-204", kind: "requestPasswordReset", status: 204, body: null },
  { name: "reset-204", kind: "resetPassword", status: 204, body: null },
  { name: "reset-weak", kind: "resetPassword", status: 400, body: '{"error":"weak_password"}' },
  { name: "email-code-204", kind: "requestEmailCode", status: 204, body: null },
  { name: "email-code-taken", kind: "requestEmailCode", status: 409, body: '{"error":"email_taken"}' },
  { name: "email-code-invalid-reauth", kind: "requestEmailCode", status: 403, body: '{"error":"invalid_reauth"}' },
  { name: "set-email-ok", kind: "setEmail", status: 200, body: '{"user":{"username":"n@b.co","email":"n@b.co"}}' },
  { name: "set-email-no-user", kind: "setEmail", status: 200, body: "{}" },
  { name: "set-email-invalid-reauth", kind: "setEmail", status: 403, body: '{"error":"invalid_reauth"}' },
  {
    name: "identities-ok",
    kind: "identities",
    status: 200,
    body: '{"identities":[{"provider":"google","email":"a@gmail.com","createdAt":3},{"provider":"apple","createdAt":4,"x":1}],"hasPassword":false}',
  },
  { name: "identities-empty", kind: "identities", status: 200, body: '{"identities":[],"hasPassword":true}' },
  { name: "identities-email-number", kind: "identities", status: 200, body: '{"identities":[{"provider":"google","email":1,"createdAt":3}],"hasPassword":true}' },
  { name: "identities-missing-has-password", kind: "identities", status: 200, body: '{"identities":[]}' },
  { name: "identities-404", kind: "identities", status: 404, body: '{"error":"not_found"}' },
  { name: "unlink-204", kind: "unlinkProvider", status: 204, body: null },
  { name: "unlink-last-method", kind: "unlinkProvider", status: 409, body: '{"error":"last_method"}' },
  { name: "reauth-code-204", kind: "requestReauthCode", status: 204, body: null },
  { name: "reauth-code-no-email", kind: "requestReauthCode", status: 409, body: '{"error":"no_email"}' },
  { name: "reauth-ok", kind: "reauth", status: 200, body: '{"reauth":"grant","expiresAt":300000}' },
  { name: "reauth-missing-expiry", kind: "reauth", status: 200, body: '{"reauth":"grant"}' },
  { name: "reauth-wrong", kind: "reauth", status: 403, body: '{"error":"invalid_code"}' },
  { name: "pending-ok", kind: "pendingSignIn", status: 200, body: '{"provider":"apple","email":"x@privaterelay.appleid.com","name":"Ann"}' },
  { name: "pending-bare", kind: "pendingSignIn", status: 200, body: '{"provider":"github"}' },
  { name: "pending-name-number", kind: "pendingSignIn", status: 200, body: '{"provider":"github","name":4}' },
  { name: "pending-not-found", kind: "pendingSignIn", status: 404, body: '{"error":"not_found"}' },
  { name: "create-from-pending-session", kind: "createFromPending", status: 200, body: '{"user":{"username":"a@b.co","email":"a@b.co"},"expiresAt":9,"token":"t"}' },
  { name: "create-from-pending-app", kind: "createFromPending", status: 200, body: '{"redirect":"pinomad://auth?code=c&state=s"}' },
  { name: "create-from-pending-loopback", kind: "createFromPending", status: 200, body: '{"redirect":"http://127.0.0.1:5000/callback?code=c&state=s"}' },
  { name: "create-from-pending-elsewhere", kind: "createFromPending", status: 200, body: '{"redirect":"https://evil.example/?code=c"}' },
  { name: "create-from-pending-app-path", kind: "createFromPending", status: 200, body: '{"redirect":"pinomad://auth/x?code=c"}' },
  { name: "create-from-pending-pair", kind: "createFromPending", status: 200, body: '{"redirect":"pinomad://pair?code=c"}' },
  { name: "create-from-pending-password-required", kind: "createFromPending", status: 400, body: '{"error":"password_required"}' },
  { name: "link-pending-204", kind: "linkPending", status: 204, body: null },
  { name: "link-pending-app", kind: "linkPending", status: 200, body: '{"redirect":"pinomad://auth/?code=c&state=s"}' },
  { name: "link-pending-empty-object", kind: "linkPending", status: 200, body: "{}" },
  { name: "link-pending-wrong", kind: "linkPending", status: 403, body: '{"error":"wrong_password"}' },
  { name: "exchange-ok", kind: "exchangeOAuthCode", status: 200, body: '{"user":{"username":"a@b.co","email":"a@b.co"},"expiresAt":9,"token":"t"}' },
  { name: "exchange-invalid-grant", kind: "exchangeOAuthCode", status: 400, body: '{"error":"invalid_grant"}' },
  { name: "apple-signed-in", kind: "appleNative", status: 200, body: '{"user":{"username":"a@b.co","email":"a@b.co"},"expiresAt":9,"token":"t"}' },
  {
    name: "apple-no-account",
    kind: "appleNative",
    status: 409,
    body: '{"error":"no_account","reason":"no_account","pending":"pnd","email":"x@privaterelay.appleid.com"}',
  },
  { name: "apple-no-account-hidden", kind: "appleNative", status: 409, body: '{"error":"no_account","pending":"pnd"}' },
  // Without the pending id, a no_account is just a refusal.
  { name: "apple-no-account-no-pending", kind: "appleNative", status: 409, body: '{"error":"no_account"}' },
  { name: "apple-invalid-token", kind: "appleNative", status: 401, body: '{"error":"invalid_token"}' },
  { name: "link-provider-url", kind: "linkProvider", status: 200, body: '{"url":"https://relay.example.com/api/oauth/google/start?link=t"}' },
  // Only a web page is opened on the server's word.
  { name: "link-provider-not-web", kind: "linkProvider", status: 200, body: '{"url":"javascript:alert(1)"}' },
  { name: "link-provider-no-url", kind: "linkProvider", status: 200, body: "{}" },
  { name: "link-provider-wrong", kind: "linkProvider", status: 403, body: '{"error":"invalid_reauth"}' },
  { name: "link-apple-204", kind: "linkAppleNative", status: 204, body: null },
  { name: "link-apple-taken", kind: "linkAppleNative", status: 409, body: '{"error":"identity_taken"}' },
  { name: "link-apple-session-ended", kind: "linkAppleNative", status: 401, body: '{"error":"session_ended"}' },
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
