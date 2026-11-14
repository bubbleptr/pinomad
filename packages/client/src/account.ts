// The server-accounts API (ADR-0022; apps/site/content/docs/remote-access.zh.md "服务端账号") as a
// client sees it: login/session ops, the account's host list, join tokens,
// and server-vouched pairing asks. Shared by web and desktop, so it
// takes fetch as an injected minimal surface — DOM and undici both
// satisfy it — and never touches a DOM-only API.
//
// crates/pinomad-core replays this client's requests and answers for iOS,
// the ADR-0044 email, provider sign-in, sign-in method and re-auth ops
// included.

import { encodeEndpointSetParam, parseEndpointSet, type EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { UNAUTHORIZED_CLOSE_CODE, type ApnsPushToken } from "@pinomad/protocol/frames.ts";
import { generateKeyPair, type KeyPair } from "@pinomad/protocol/noise.ts";
import { pairingFragment, parsePairParam } from "@pinomad/protocol/pairing-link.ts";
import {
  candidatePlan,
  preferredLegacyUrl,
  type RemoteCandidateRole,
} from "@pinomad/protocol/remote-candidates.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { FrameConnection } from "@pinomad/protocol/transport.ts";
import type { StoredHost } from "./stored-host.ts";

/**
 * The slice of fetch the account client needs. DOM `fetch` and undici's are
 * both assignable here; other runtimes can supply the same shape.
 */
export interface AccountFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly redirect?: "follow" | "error" | "manual";
  readonly signal?: AbortSignal;
}

export interface AccountFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type AccountFetch = (url: string, init?: AccountFetchInit) => Promise<AccountFetchResponse>;

const fallbackFetch = (url: string, init?: AccountFetchInit): Promise<AccountFetchResponse> =>
  // Wrapped, not referenced: some runtimes' fetch misbehaves unbound.
  fetch(url, init);

/**
 * An API failure the UI maps straight to copy. `code` is the server's `error`
 * verbatim — invalid_credentials, rate_limited, host_offline, host_too_old,
 * key_mismatch, disabled, not_joined, rebinding, host_timeout,
 * unauthenticated, accounts_disabled, not_found, and friends — plus two the
 * client invents: `network` when no usable answer arrived, and
 * `invalid_response` when a 2xx body didn't match the endpoint's shape.
 */
export interface AccountError {
  readonly code: string;
  readonly status?: number;
  /** Per-path evidence for an account pairing attempt; absent on other API errors. */
  readonly candidates?: readonly PairCandidateDiagnostic[];
}

/** Why one offered pairing candidate did not complete message 2. */
export type PairCandidateOutcome = "unsupported" | "rejected" | "unreachable" | "timeout";

export interface PairCandidateDiagnostic {
  readonly url: string;
  readonly role: RemoteCandidateRole;
  readonly outcome: PairCandidateOutcome;
  /** The close code when the host answered. */
  readonly code?: number;
  readonly reason?: string;
}

export type AccountResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AccountError };

const ok = <T>(value: T): AccountResult<T> => ({ ok: true, value });
const fail = (code: string, status?: number): { readonly ok: false; readonly error: AccountError } => ({
  ok: false,
  error: { code, ...(status === undefined ? {} : { status }) },
});

/**
 * Pairing failed on every path. Only a round whose every DIALED path was
 * rejected can be called `pair_rejected`; a single relay's unauthenticated
 * 4401 must not overwrite a timeout or unreachable direct. Unsupported paths
 * are never dialed and do not vote. The diagnostics keep every path's reason,
 * rejected ones included.
 */
const pairFailure = (candidates: readonly PairCandidateDiagnostic[]): {
  readonly ok: false;
  readonly error: AccountError;
} => {
  const dialed = candidates.filter((candidate) => candidate.outcome !== "unsupported");
  const allRejected = dialed.length > 0 && dialed.every((candidate) => candidate.outcome === "rejected");
  const any = (outcome: PairCandidateOutcome): boolean =>
    dialed.some((candidate) => candidate.outcome === outcome);
  const code = allRejected
    ? "pair_rejected"
    : any("timeout")
      ? "pair_timeout"
      : any("unreachable")
        ? "pair_unreachable"
        : candidates.some((candidate) => candidate.outcome === "unsupported")
          ? "pair_unsupported"
          : "pair_unreachable";
  return {
    ok: false,
    error: { code, ...(candidates.length === 0 ? {} : { candidates }) },
  };
};

/** The session is gone (or was never there): time to log in again. */
export const isUnauthenticated = (error: AccountError): boolean => error.code === "unauthenticated";

/** Whether a server origin runs accounts. Same verdicts the host CLI uses. */
export type AccountsProbe = "enabled" | "disabled" | "unreachable";

/**
 * /api/me as the account probe: 401 means the API exists but wants a session;
 * a JSON user means a live session; a 404 (`accounts_disabled`, or an old
 * server with no /api) or an SPA's index.html means "no accounts". Anything
 * else — a proxy 502, a WAF 403 — is "unreachable": we can't tell.
 */
export async function probeAccounts(origin: string, fetchImpl: AccountFetch = fallbackFetch): Promise<AccountsProbe> {
  // An explicit controller plus setTimeout, not AbortSignal.timeout: the
  // timer stays armed through the body read — a stalled body after the
  // headers (a half-dead proxy) must still count as unreachable.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5_000);
  try {
    const response = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/me`, {
      signal: timeout.signal,
      redirect: "manual",
    });
    if (response.status === 401) return "enabled";
    if (response.status === 200) {
      // Read the body inside the timeout's reach: a stalled body (half-dead
      // proxy) is "unreachable", but a fully-read body that isn't JSON — an
      // SPA's index.html — is a plain "disabled".
      const text = await response.text();
      let body: { user?: unknown } | undefined;
      try {
        body = JSON.parse(text) as { user?: unknown };
      } catch {
        return "disabled";
      }
      return typeof body?.user === "object" && body.user !== null ? "enabled" : "disabled";
    }
    return response.status === 404 ? "disabled" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Account traffic is TLS-only (ADR-0022): a plaintext join or login would hand
 * a bearer or one-use token to anyone on the path. Loopback http stays for
 * local development. Same rule as the host CLI's assertSecureServerOrigin.
 */
export function isSecureServerOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  // The parser already canonicalized every IPv4 spelling (`127.1`, `0x7f.1`,
  // `2130706433`) to dotted form, so a strict quad match is an address check
  // — a `127.example.com` domain no longer slips through a string prefix.
  const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(host);
  const loopback =
    host === "localhost" || host.endsWith(".localhost") || ipv4Loopback || host === "::1" || host === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}

/**
 * An origin in canonical comparison form — `new URL().origin` strips trailing
 * slashes and default ports so "https://a.example/" and "https://a.example"
 * are the same server. Unparseable input survives verbatim.
 */
export function normalizeServerOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

/**
 * The credential form a client holds (ADR-0022 §2): ambient cookie, or a
 * bearer token — absent while logging in, when there is none yet.
 */
export type AccountCredentials = { readonly mode: "cookie" } | { readonly mode: "bearer"; readonly token?: string };

export interface AccountUser {
  /** What to show for the account: its email, or a legacy username (ADR-0044 §8). */
  readonly username: string;
  /** The account's verified email; absent on legacy accounts that have none yet. */
  readonly email?: string;
  /**
   * Stable and opaque: what this device files the pairings the account
   * vouched for under (#640). Absent from servers that predate it.
   */
  readonly accountId?: string;
}

/** The signed-in account as GET /api/me reports it. */
export interface AccountProfile {
  readonly user: AccountUser;
  /**
   * A legacy account without a verified email on a server that can mail
   * codes: the client asks for one before going on (ADR-0044 §8).
   */
  readonly needsEmail?: true;
}

export interface LoginSuccess extends AccountProfile {
  readonly expiresAt: number;
  /** Present only in bearer mode — cookie-mode sessions never expose the token to JS. */
  readonly token?: string;
}

export interface JoinToken {
  readonly token: string;
  readonly expiresAt: number;
  /** The ready-to-show command for the "add a host" flow (`pinomad join …`). */
  readonly command: string;
}

/** How a server lets people in (GET /api/auth/methods, ADR-0044). */
export interface AuthMethods {
  /** New accounts can be created here. */
  readonly registration: boolean;
  /** The server can mail codes: email sign-up and password reset work. */
  readonly email: boolean;
  /** Third-party sign-in providers the server has configured. */
  readonly providers: readonly string[];
}

/**
 * The second check before an action on the account (ADR-0044 §6): the
 * password as a string, or a grant from `reauth`, which only counts for the
 * session that got it and lapses after five minutes.
 */
export type AccountConfirmation = string | { readonly reauth: string };

/** A confirmation as request bodies carry it. */
const confirmationBody = (confirmation: AccountConfirmation): { password: string } | { reauth: string } =>
  typeof confirmation === "string" ? { password: confirmation } : { reauth: confirmation.reauth };

/** The password or a re-auth grant, as the email routes take them by name. */
export type EmailConfirmation = { readonly password: string } | { readonly reauth: string };

const emailConfirmationBody = (input: EmailConfirmation): { password: string } | { reauth: string } =>
  "reauth" in input ? { reauth: input.reauth } : { password: input.password };

/**
 * Where a native app's link from settings comes back to (#631): the same
 * redirects native sign-in allows (`pinomad://auth`, or the desktop's
 * `http://127.0.0.1:<port>/callback`), with a PKCE challenge and the app's
 * state. The verifier stays with the app until `completeLink`.
 */
export interface NativeLinkRedirect {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
}

/** A sign-in provider bound to the account (GET /api/me/identities). */
export interface AccountIdentity {
  /** "google", "github" or "apple". */
  readonly provider: string;
  /** The email the provider gave, which may differ from the account's. */
  readonly email?: string;
  readonly createdAt: number;
}

/** The account's ways in: its providers, and whether it has a password. */
export interface AccountIdentities {
  readonly identities: readonly AccountIdentity[];
  readonly hasPassword: boolean;
}

/** A re-auth grant (ADR-0044 §6). */
export interface ReauthGrant {
  readonly reauth: string;
  readonly expiresAt: number;
}

/** A provider sign-in that found no account yet (ADR-0044 §4), as its page shows it. */
export interface PendingSignIn {
  readonly provider: string;
  readonly email?: string;
  readonly name?: string;
}

/**
 * Where finishing a pending sign-in leaves the caller: signed in, or — when a
 * native app started it — the app's redirect with a one-time code, to send
 * the browser to.
 */
export type PendingOutcome =
  | { readonly kind: "signedIn"; readonly session: LoginSuccess }
  | { readonly kind: "redirect"; readonly url: string };

/** Native Sign in with Apple: signed in, or no account yet with the pending id to create or link it. */
export type AppleNativeOutcome =
  | { readonly kind: "signedIn"; readonly session: LoginSuccess }
  | { readonly kind: "noAccount"; readonly pending: string; readonly email?: string };

/** One account-bound host row as GET /api/hosts reports it. */
export interface AccountHost {
  readonly hostId: string;
  readonly name: string;
  readonly noisePublicKey: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  /** Whether a pairing ask can go to this host right now (server-side verdict). */
  readonly pairing: "available" | "offline" | "host_too_old" | "key_mismatch";
  /**
   * As of the host's latest register: false means the server can't ask it to
   * revoke a device — that happens on the host (ADR-0037 §5). Absent from
   * servers older than #452.
   */
  readonly deviceReports?: boolean;
  /**
   * When the host joined the account, epoch ms; a host back after a removal
   * joined anew (#531). Absent from servers older than it.
   */
  readonly joinedAt?: number;
}

/**
 * This install's claim at login and sign-up (ADR-0037 §1): a random id it
 * generated once and keeps, plus a label. A tag inside the account, not a
 * credential.
 */
export interface AccountDeviceClaim {
  /** 22–64 base64url characters; the server refuses anything else with 400. */
  readonly id: string;
  readonly name?: string;
}

/** One account device's standing on a host it joined through the account (ADR-0037 §6). */
export interface AccountDeviceHost {
  readonly hostId: string;
  readonly name: string;
  /** "revoking": the server asked and the host hasn't confirmed yet. */
  readonly state: "registered" | "revoking" | "revoked";
}

/** One row of GET /api/devices. */
export interface AccountDevice {
  /** The server's id, which kickDevice takes; not the client's own device id. */
  readonly id: number;
  /** Absent for clients that never said (older apps, sessions from before #452). */
  readonly name?: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  /** The device whose session made this request. */
  readonly current: boolean;
  readonly kickedAt?: number;
  readonly hosts: readonly AccountDeviceHost[];
}

/**
 * A host waiting to join the account (#495), as POST /api/host-link/lookup
 * describes it for the confirm page.
 */
export interface HostLinkRequest {
  /** The host's id: the fingerprint of its registration key. */
  readonly hostId: string;
  readonly name: string;
  readonly os: string;
  /** The address the host asked from. */
  readonly sourceIp: string;
  /** The host asked from another address than this device's: maybe not the caller's machine. */
  readonly ipDiffers: boolean;
  readonly expiresAt: number;
}

/** The answer to POST /api/hosts/:hostId/pairing — the vouched one-time offer. */
export interface PairingOffer {
  readonly url: string;
  readonly hostKey: string;
  readonly secret: string;
  readonly expiresAt: number;
  /** Remote candidates forwarded additively by the server (ADR-0032); absent on older servers. */
  readonly endpointSet?: EndpointSet;
}

export interface AccountClient {
  /** The normalized origin every request targets. */
  readonly origin: string;
  /** `device` ties the session to this install's account device (ADR-0037 §1); older servers ignore it. */
  login(username: string, password: string, device?: AccountDeviceClaim): Promise<AccountResult<LoginSuccess>>;
  authMethods(): Promise<AccountResult<AuthMethods>>;
  /**
   * Mails a sign-up code (ADR-0044 §2). The answer is the same whether or
   * not the email already has an account; 403 `registration_closed` when
   * the server takes no sign-ups.
   */
  requestSignupCode(email: string): Promise<AccountResult<void>>;
  /** Creates an account from the mailed code and signs it in, like login. */
  register(input: {
    readonly email: string;
    readonly code: string;
    readonly password: string;
    readonly device?: AccountDeviceClaim;
  }): Promise<AccountResult<LoginSuccess>>;
  /** Mails a reset code when the email has an account; the answer doesn't say. */
  requestPasswordReset(email: string): Promise<AccountResult<void>>;
  /** Sets a new password and signs the account out everywhere; log in afterwards. */
  resetPassword(input: { readonly email: string; readonly code: string; readonly password: string }): Promise<AccountResult<void>>;
  /**
   * Mails a code to an email the signed-in account wants to use, after the
   * current password or, for an account without one, a re-auth grant: 403
   * `wrong_password` or `invalid_reauth` is a refusal, not a sign-out; 409
   * `email_taken` when another account has the email.
   */
  requestEmailCode(input: { readonly email: string } & EmailConfirmation): Promise<AccountResult<void>>;
  /** Makes the mailed-to email the account's verified email; confirmed again, as for the code. */
  setEmail(input: { readonly email: string; readonly code: string } & EmailConfirmation): Promise<AccountResult<AccountProfile>>;
  me(): Promise<AccountResult<AccountProfile>>;
  /**
   * Ends this session. `revoke` also has the server ask every host this
   * device joined through the account to revoke it (#494); a server that
   * predates it ignores the body and only signs out, with the same answer.
   */
  logout(options?: { readonly revoke?: boolean }): Promise<AccountResult<void>>;
  revokeAllSessions(): Promise<AccountResult<void>>;
  /**
   * Keeps this session and signs out the account's others; 403
   * `wrong_password` or `invalid_reauth` doesn't sign out (#450). A grant
   * also sets a first password on an account that has none.
   */
  changePassword(current: AccountConfirmation, newPassword: string): Promise<AccountResult<void>>;
  /**
   * Deletes the signed-in account and ends this session (#451). 403
   * `wrong_password` or `invalid_reauth` is a refusal, not a sign-out.
   */
  deleteAccount(confirmation: AccountConfirmation): Promise<AccountResult<void>>;
  /** Mails a re-auth code to the account's email; 409 `no_email` for an account without one. */
  requestReauthCode(): Promise<AccountResult<void>>;
  /** Trades the password or a mailed code for a grant; wrong ones count toward the sign-in lockout (429 `rate_limited`). */
  reauth(proof: { readonly password: string } | { readonly code: string }): Promise<AccountResult<ReauthGrant>>;
  /** The account's sign-in providers and whether it has a password. */
  identities(): Promise<AccountResult<AccountIdentities>>;
  /**
   * Starts adding a provider to the account: the URL to open in this
   * browser, which comes back to `/?oauth_linked=<provider>` or
   * `/?oauth_error=<reason>`. A native app (#631) passes its redirect
   * instead and opens the one-time URL in its own browser, which comes back
   * to `redirectUri?code=…&state=…` (traded by `completeLink`) or
   * `?error=…&state=…`.
   */
  linkProvider(provider: string, confirmation: AccountConfirmation, native?: NativeLinkRedirect): Promise<AccountResult<string>>;
  /**
   * Finishes a native app's link (#631): the code its redirect got and the
   * PKCE verifier behind the challenge it sent. 400 `invalid_grant` for a
   * spent or foreign code, 409 `identity_taken`.
   */
  completeLink(code: string, codeVerifier: string): Promise<AccountResult<void>>;
  /** Binds iOS's own Sign in with Apple to the signed-in account (#631); 409 `identity_taken` when another account has it. */
  linkAppleNative(
    input: { readonly identityToken: string; readonly authorizationCode: string; readonly nonce?: string; readonly name?: string },
    confirmation: AccountConfirmation,
  ): Promise<AccountResult<void>>;
  /** Removes a provider; 409 `last_method` when nothing else would sign the account in. */
  unlinkProvider(provider: string, confirmation: AccountConfirmation): Promise<AccountResult<void>>;
  /** The provider sign-in behind `/?oauth_pending=<id>`; 404 `not_found` once spent, expired, or another browser's. */
  pendingSignIn(id: string): Promise<AccountResult<PendingSignIn>>;
  /**
   * Creates the account a pending sign-in asked for and finishes the sign-in.
   * A server that can't mail (`authMethods().email` false) needs a
   * `password`, the account's only way to confirm changes later: 400
   * `password_required` without one, `weak_password` under 12 characters.
   */
  createFromPending(
    id: string,
    options?: { readonly password?: string; readonly device?: AccountDeviceClaim },
  ): Promise<AccountResult<PendingOutcome>>;
  /**
   * Adds a pending sign-in's provider to the signed-in account, confirmed
   * like `linkProvider`. Answers the native app's redirect when an app
   * started it, else nothing.
   */
  linkPending(id: string, confirmation: AccountConfirmation): Promise<AccountResult<string | undefined>>;
  /** A native app's one-time code and its PKCE verifier, traded for a session like a login. */
  exchangeOAuthCode(code: string, codeVerifier: string, device?: AccountDeviceClaim): Promise<AccountResult<LoginSuccess>>;
  /** iOS's own Sign in with Apple; `nonce` is the raw value whose SHA-256 the app gave Apple. */
  appleNative(input: {
    readonly identityToken: string;
    readonly authorizationCode: string;
    readonly nonce?: string;
    readonly name?: string;
    readonly device?: AccountDeviceClaim;
  }): Promise<AccountResult<AppleNativeOutcome>>;
  createJoinToken(): Promise<AccountResult<JoinToken>>;
  /**
   * The host waiting behind a code typed from its terminal (#495). The code
   * goes as typed; the server ignores case, dashes and spaces. 404
   * `not_found` is a wrong, spent or expired code, 429 `rate_limited` the
   * lockout after too many of those.
   */
  lookupHostLink(userCode: string): Promise<AccountResult<HostLinkRequest>>;
  /** Lets that host join this account; same refusals as lookup. */
  confirmHostLink(userCode: string): Promise<AccountResult<void>>;
  /** Turns that host away; same refusals as lookup. */
  denyHostLink(userCode: string): Promise<AccountResult<void>>;
  /**
   * A loopback host link (#513): the request its confirm URL names by id.
   * 404 `not_found` is an unknown, settled or expired request.
   */
  lookupHostLinkRequest(requestId: string): Promise<AccountResult<HostLinkRequest>>;
  /**
   * Lets that host join and answers where to send the browser: the host's
   * own `http://127.0.0.1:<port>` listener, which receives a one-time code.
   * Any other answer is `invalid_response`.
   */
  confirmHostLinkRequest(requestId: string): Promise<AccountResult<string>>;
  /** Turns that host away; the redirect tells its listener so. */
  denyHostLinkRequest(requestId: string): Promise<AccountResult<string>>;
  listHosts(): Promise<AccountResult<readonly AccountHost[]>>;
  /**
   * Takes a host out of the account after checking the password again
   * (#512): it stops dialing the server and only its own terminal can join
   * it back. 403 `wrong_password` is a refusal, not a sign-out; 404
   * `not_found` covers servers that predate it.
   */
  removeHost(hostId: string, confirmation: AccountConfirmation): Promise<AccountResult<void>>;
  /** The account's devices (#452); 404 on servers that predate them. */
  listDevices(): Promise<AccountResult<readonly AccountDevice[]>>;
  /**
   * Signs a device out of the account and asks every host it joined through
   * the account to revoke it (ADR-0037 §3). 403 `wrong_password` is a
   * refusal, not a sign-out; 409 `current_device` means sign out instead.
   */
  kickDevice(id: number, confirmation: AccountConfirmation): Promise<AccountResult<void>>;
  requestPairing(hostId: string): Promise<AccountResult<PairingOffer>>;
  /** Record this device's APNs token under the signed-in account (ADR-0036). */
  registerPushToken(token: ApnsPushToken): Promise<AccountResult<void>>;
  removePushToken(token: ApnsPushToken): Promise<AccountResult<void>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hostLinkRequestBody = (value: unknown): HostLinkRequest | undefined =>
  isRecord(value) &&
  typeof value.hostId === "string" &&
  typeof value.name === "string" &&
  typeof value.os === "string" &&
  typeof value.sourceIp === "string" &&
  typeof value.ipDiffers === "boolean" &&
  typeof value.expiresAt === "number"
    ? {
        hostId: value.hostId,
        name: value.name,
        os: value.os,
        sourceIp: value.sourceIp,
        ipDiffers: value.ipDiffers,
        expiresAt: value.expiresAt,
      }
    : undefined;

/**
 * A loopback host link's redirect (#513), only when it goes to this
 * machine's 127.0.0.1 over plain http, as the server allows at start: the
 * client never sends a browser anywhere else on the server's word.
 */
const loopbackRedirectBody = (value: unknown): string | undefined => {
  if (!isRecord(value) || typeof value.redirect !== "string") return undefined;
  try {
    const url = new URL(value.redirect);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" ? value.redirect : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A native app's redirect after a provider sign-in, only to where the server
 * allows one at start (ADR-0044 §5): `pinomad://auth`, or this machine's
 * 127.0.0.1 over plain http.
 */
const nativeRedirectBody = (value: unknown): string | undefined => {
  if (!isRecord(value) || typeof value.redirect !== "string") return undefined;
  try {
    const url = new URL(value.redirect);
    const app = url.protocol === "pinomad:" && url.host === "auth" && (url.pathname === "" || url.pathname === "/");
    return app || loopbackRedirectBody(value) !== undefined ? value.redirect : undefined;
  } catch {
    return undefined;
  }
};

const userBody = (value: unknown): AccountProfile | undefined => {
  if (!isRecord(value) || !isRecord(value.user) || typeof value.user.username !== "string") return undefined;
  const { username, email, accountId } = value.user;
  return {
    user: {
      username,
      ...(typeof email === "string" ? { email } : {}),
      ...(typeof accountId === "string" && accountId !== "" ? { accountId } : {}),
    },
    ...(value.needsEmail === true ? { needsEmail: true as const } : {}),
  };
};

const DEVICE_HOST_STATES = new Set(["registered", "revoking", "revoked"]);

const isDeviceHost = (value: unknown): value is AccountDeviceHost =>
  isRecord(value) &&
  typeof value.hostId === "string" &&
  typeof value.name === "string" &&
  typeof value.state === "string" &&
  DEVICE_HOST_STATES.has(value.state);

const isDevice = (value: unknown): value is AccountDevice =>
  isRecord(value) &&
  typeof value.id === "number" &&
  (value.name === undefined || typeof value.name === "string") &&
  typeof value.createdAt === "number" &&
  typeof value.lastSeenAt === "number" &&
  typeof value.current === "boolean" &&
  (value.kickedAt === undefined || typeof value.kickedAt === "number") &&
  Array.isArray(value.hosts) &&
  value.hosts.every(isDeviceHost);

/** The claim as the body carries it: id first, name only when there is one. */
const deviceBody = (device: AccountDeviceClaim | undefined) =>
  device === undefined
    ? {}
    : { device: { id: device.id, ...(device.name === undefined ? {} : { name: device.name }) } };

/**
 * A client for one server's account API. `credentials` picks how requests
 * authenticate: "cookie" sends `same-origin` credentials and relies on the
 * browser jar (mutating requests get the same-origin Origin header from the
 * fetch itself); "bearer" sets `Authorization: Bearer <token>` and needs no
 * ambient credential, so no Origin check applies server-side.
 */
export function createAccountClient(options: {
  readonly origin: string;
  readonly credentials: AccountCredentials;
  readonly fetch?: AccountFetch;
}): AccountClient {
  const fetchImpl = options.fetch ?? fallbackFetch;
  const origin = normalizeServerOrigin(options.origin);
  const bearer = options.credentials.mode === "bearer" ? options.credentials.token : undefined;
  // Never follow redirects: a 307 pointing at http:// would replay the
  // bearer or the login body in plaintext. "manual" surfaces the 3xx (undici)
  // or an opaque status-0 answer (DOM); an implementation that silently
  // ignores unknown init fields must refuse redirects in its own layer.
  const init: AccountFetchInit = {
    redirect: "manual",
    ...(options.credentials.mode === "cookie" ? { credentials: "same-origin" as const } : {}),
  };

  /** Like `request`, but a refusal keeps its body: some carry more than the code. */
  const exchange = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<AccountResult<unknown> | { readonly ok: false; readonly error: AccountError; readonly body: unknown }> => {
    let response: AccountFetchResponse;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...init,
        method,
        headers: {
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail("network");
    }
    // An opaqueredirect (DOM `manual` mode) carries status 0 and no readable
    // target — a transport failure, not an API answer.
    if (response.status === 0) return fail("network");
    // 204s carry no body; json() on empty input throws, treated as absent.
    const json = await response.json().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return ok(json);
    const code = isRecord(json) && typeof json.error === "string" ? json.error : response.status === 401 ? "unauthenticated" : "unknown";
    return { ...fail(code, response.status), body: json };
  };

  const request = async (path: string, method: "GET" | "POST", body?: unknown): Promise<AccountResult<unknown>> => {
    const result = await exchange(path, method, body);
    return result.ok ? result : { ok: false, error: result.error };
  };

  const done = (result: AccountResult<unknown>): AccountResult<void> => (result.ok ? ok(undefined) : result);

  const session = (result: AccountResult<unknown>): AccountResult<LoginSuccess> => {
    if (!result.ok) return result;
    const base = userBody(result.value);
    if (base === undefined || !isRecord(result.value) || typeof result.value.expiresAt !== "number") {
      return fail("invalid_response");
    }
    const token = result.value.token;
    return ok({
      ...base,
      expiresAt: result.value.expiresAt,
      ...(typeof token === "string" ? { token } : {}),
    });
  };

  return {
    origin,
    login: async (username, password, device) =>
      session(await request("/api/login", "POST", { username, password, ...deviceBody(device) })),
    authMethods: async () => {
      const result = await request("/api/auth/methods", "GET");
      if (!result.ok) return result;
      const value = result.value;
      if (
        !isRecord(value) ||
        typeof value.registration !== "boolean" ||
        typeof value.email !== "boolean" ||
        !Array.isArray(value.providers) ||
        !value.providers.every((provider) => typeof provider === "string")
      ) {
        return fail("invalid_response");
      }
      return ok({ registration: value.registration, email: value.email, providers: value.providers as string[] });
    },
    requestSignupCode: async (email) => {
      const result = await request("/api/register/code", "POST", { email });
      return result.ok ? ok(undefined) : result;
    },
    register: async ({ email, code, password, device }) =>
      session(await request("/api/register", "POST", { email, code, password, ...deviceBody(device) })),
    requestPasswordReset: async (email) => {
      const result = await request("/api/password/reset/code", "POST", { email });
      return result.ok ? ok(undefined) : result;
    },
    resetPassword: async ({ email, code, password }) => {
      const result = await request("/api/password/reset", "POST", { email, code, password });
      return result.ok ? ok(undefined) : result;
    },
    requestEmailCode: async (input) => {
      const result = await request("/api/me/email/code", "POST", { email: input.email, ...emailConfirmationBody(input) });
      return result.ok ? ok(undefined) : result;
    },
    setEmail: async (input) => {
      const result = await request("/api/me/email", "POST", { email: input.email, code: input.code, ...emailConfirmationBody(input) });
      if (!result.ok) return result;
      const value = userBody(result.value);
      return value === undefined ? fail("invalid_response") : ok(value);
    },
    me: async () => {
      const result = await request("/api/me", "GET");
      if (!result.ok) return result;
      const value = userBody(result.value);
      return value === undefined ? fail("invalid_response") : ok(value);
    },
    logout: async (options) => {
      const result = await request("/api/logout", "POST", options?.revoke === true ? { revoke: true } : undefined);
      return result.ok ? ok(undefined) : result;
    },
    revokeAllSessions: async () => {
      const result = await request("/api/sessions/revoke-all", "POST");
      return result.ok ? ok(undefined) : result;
    },
    changePassword: async (current, newPassword) => {
      const proof = typeof current === "string" ? { currentPassword: current } : { reauth: current.reauth };
      return done(await request("/api/password", "POST", { ...proof, newPassword }));
    },
    deleteAccount: async (confirmation) => done(await request("/api/me/delete", "POST", confirmationBody(confirmation))),
    requestReauthCode: async () => done(await request("/api/reauth/code", "POST", {})),
    reauth: async (proof) => {
      const result = await request("/api/reauth", "POST", proof);
      if (!result.ok) return result;
      const value = result.value;
      return isRecord(value) && typeof value.reauth === "string" && typeof value.expiresAt === "number"
        ? ok({ reauth: value.reauth, expiresAt: value.expiresAt })
        : fail("invalid_response");
    },
    identities: async () => {
      const result = await request("/api/me/identities", "GET");
      if (!result.ok) return result;
      const value = result.value;
      const valid =
        isRecord(value) &&
        typeof value.hasPassword === "boolean" &&
        Array.isArray(value.identities) &&
        value.identities.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.provider === "string" &&
            (entry.email === undefined || typeof entry.email === "string") &&
            typeof entry.createdAt === "number",
        );
      if (!valid) return fail("invalid_response");
      return ok({
        hasPassword: value.hasPassword as boolean,
        identities: (value.identities as AccountIdentity[]).map((entry) => ({
          provider: entry.provider,
          ...(entry.email === undefined ? {} : { email: entry.email }),
          createdAt: entry.createdAt,
        })),
      });
    },
    linkProvider: async (provider, confirmation, native) => {
      const result = await request(`/api/oauth/${encodeURIComponent(provider)}/link`, "POST", {
        ...confirmationBody(confirmation),
        ...(native === undefined
          ? {}
          : { client: "native", redirect_uri: native.redirectUri, code_challenge: native.codeChallenge, state: native.state }),
      });
      if (!result.ok) return result;
      // Only a web page: the browser is sent there on the server's word.
      const url = isRecord(result.value) ? result.value.url : undefined;
      return typeof url === "string" && /^https?:\/\//.test(url) ? ok(url) : fail("invalid_response");
    },
    unlinkProvider: async (provider, confirmation) =>
      done(await request(`/api/me/identities/${encodeURIComponent(provider)}/remove`, "POST", confirmationBody(confirmation))),
    pendingSignIn: async (id) => {
      const result = await request(`/api/oauth/pending/${encodeURIComponent(id)}`, "GET");
      if (!result.ok) return result;
      const value = result.value;
      if (
        !isRecord(value) ||
        typeof value.provider !== "string" ||
        (value.email !== undefined && typeof value.email !== "string") ||
        (value.name !== undefined && typeof value.name !== "string")
      ) {
        return fail("invalid_response");
      }
      return ok({
        provider: value.provider,
        ...(value.email === undefined ? {} : { email: value.email as string }),
        ...(value.name === undefined ? {} : { name: value.name as string }),
      });
    },
    createFromPending: async (id, options) => {
      const result = await request(`/api/oauth/pending/${encodeURIComponent(id)}/create`, "POST", {
        ...(options?.password === undefined ? {} : { password: options.password }),
        ...deviceBody(options?.device),
      });
      if (!result.ok) return result;
      if (isRecord(result.value) && "redirect" in result.value) {
        const url = nativeRedirectBody(result.value);
        return url === undefined ? fail("invalid_response") : ok({ kind: "redirect", url });
      }
      const signedIn = session(result);
      return signedIn.ok ? ok({ kind: "signedIn", session: signedIn.value }) : signedIn;
    },
    linkPending: async (id, confirmation) => {
      const result = await request(`/api/oauth/pending/${encodeURIComponent(id)}/link`, "POST", confirmationBody(confirmation));
      if (!result.ok) return result;
      if (result.value === undefined) return ok(undefined);
      const url = nativeRedirectBody(result.value);
      return url === undefined ? fail("invalid_response") : ok(url);
    },
    exchangeOAuthCode: async (code, codeVerifier, device) =>
      session(await request("/api/oauth/token", "POST", { code, code_verifier: codeVerifier, ...deviceBody(device) })),
    appleNative: async ({ identityToken, authorizationCode, nonce, name, device }) => {
      const result = await exchange("/api/oauth/apple/native", "POST", {
        identityToken,
        authorizationCode,
        ...(nonce === undefined ? {} : { nonce }),
        ...(name === undefined ? {} : { name }),
        ...deviceBody(device),
      });
      if (!result.ok) {
        const body = "body" in result ? result.body : undefined;
        if (result.error.code === "no_account" && isRecord(body) && typeof body.pending === "string") {
          return ok({ kind: "noAccount", pending: body.pending, ...(typeof body.email === "string" ? { email: body.email } : {}) });
        }
        return { ok: false, error: result.error };
      }
      const signedIn = session(result);
      return signedIn.ok ? ok({ kind: "signedIn", session: signedIn.value }) : signedIn;
    },
    completeLink: async (code, codeVerifier) =>
      done(await request("/api/oauth/link/complete", "POST", { code, code_verifier: codeVerifier })),
    linkAppleNative: async ({ identityToken, authorizationCode, nonce, name }, confirmation) =>
      done(
        await request("/api/oauth/apple/native", "POST", {
          identityToken,
          authorizationCode,
          ...(nonce === undefined ? {} : { nonce }),
          ...(name === undefined ? {} : { name }),
          ...confirmationBody(confirmation),
        }),
      ),
    createJoinToken: async () => {
      const result = await request("/api/join-tokens", "POST");
      if (!result.ok) return result;
      const value = result.value;
      if (
        !isRecord(value) ||
        typeof value.token !== "string" ||
        typeof value.expiresAt !== "number" ||
        typeof value.command !== "string"
      ) {
        return fail("invalid_response");
      }
      return ok({ token: value.token, expiresAt: value.expiresAt, command: value.command });
    },
    lookupHostLink: async (userCode) => {
      const result = await request("/api/host-link/lookup", "POST", { userCode });
      if (!result.ok) return result;
      const parsed = hostLinkRequestBody(result.value);
      return parsed === undefined ? fail("invalid_response") : ok(parsed);
    },
    confirmHostLink: async (userCode) => {
      const result = await request("/api/host-link/confirm", "POST", { userCode });
      return result.ok ? ok(undefined) : result;
    },
    denyHostLink: async (userCode) => {
      const result = await request("/api/host-link/deny", "POST", { userCode });
      return result.ok ? ok(undefined) : result;
    },
    lookupHostLinkRequest: async (requestId) => {
      const result = await request("/api/host-link/lookup", "POST", { requestId });
      if (!result.ok) return result;
      const parsed = hostLinkRequestBody(result.value);
      return parsed === undefined ? fail("invalid_response") : ok(parsed);
    },
    confirmHostLinkRequest: async (requestId) => {
      const result = await request("/api/host-link/confirm", "POST", { requestId });
      if (!result.ok) return result;
      const redirect = loopbackRedirectBody(result.value);
      return redirect === undefined ? fail("invalid_response") : ok(redirect);
    },
    denyHostLinkRequest: async (requestId) => {
      const result = await request("/api/host-link/deny", "POST", { requestId });
      if (!result.ok) return result;
      const redirect = loopbackRedirectBody(result.value);
      return redirect === undefined ? fail("invalid_response") : ok(redirect);
    },
    listHosts: async () => {
      const result = await request("/api/hosts", "GET");
      if (!result.ok) return result;
      if (!Array.isArray(result.value)) return fail("invalid_response");
      const hosts: AccountHost[] = [];
      for (const entry of result.value) {
        if (
          !isRecord(entry) ||
          typeof entry.hostId !== "string" ||
          typeof entry.name !== "string" ||
          typeof entry.noisePublicKey !== "string" ||
          typeof entry.online !== "boolean" ||
          typeof entry.lastSeenAt !== "number" ||
          (entry.pairing !== "available" && entry.pairing !== "offline" && entry.pairing !== "host_too_old" && entry.pairing !== "key_mismatch") ||
          (entry.deviceReports !== undefined && typeof entry.deviceReports !== "boolean") ||
          (entry.joinedAt !== undefined && typeof entry.joinedAt !== "number")
        ) {
          return fail("invalid_response");
        }
        hosts.push({
          hostId: entry.hostId,
          name: entry.name,
          noisePublicKey: entry.noisePublicKey,
          online: entry.online,
          lastSeenAt: entry.lastSeenAt,
          pairing: entry.pairing,
          ...(entry.deviceReports === undefined ? {} : { deviceReports: entry.deviceReports }),
          ...(entry.joinedAt === undefined ? {} : { joinedAt: entry.joinedAt }),
        });
      }
      return ok(hosts);
    },
    listDevices: async () => {
      const result = await request("/api/devices", "GET");
      if (!result.ok) return result;
      if (!Array.isArray(result.value) || !result.value.every(isDevice)) return fail("invalid_response");
      return ok(
        result.value.map((device) => ({
          id: device.id,
          ...(device.name === undefined ? {} : { name: device.name }),
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          current: device.current,
          ...(device.kickedAt === undefined ? {} : { kickedAt: device.kickedAt }),
          hosts: device.hosts.map((host) => ({ hostId: host.hostId, name: host.name, state: host.state })),
        })),
      );
    },
    removeHost: async (hostId, confirmation) =>
      done(await request(`/api/hosts/${encodeURIComponent(hostId)}/remove`, "POST", confirmationBody(confirmation))),
    kickDevice: async (id, confirmation) => done(await request(`/api/devices/${id}/kick`, "POST", confirmationBody(confirmation))),
    requestPairing: async (hostId) => {
      const result = await request(`/api/hosts/${encodeURIComponent(hostId)}/pairing`, "POST");
      if (!result.ok) return result;
      const value = result.value;
      if (
        !isRecord(value) ||
        typeof value.url !== "string" ||
        typeof value.hostKey !== "string" ||
        typeof value.secret !== "string" ||
        typeof value.expiresAt !== "number"
      ) {
        return fail("invalid_response");
      }
      // A pairing invite with an explicit empty set is malformed (ADR-0032
      // §8); unknown schemas fall back to the legacy url, as on the host's
      // own pairing link.
      let endpointSet: EndpointSet | undefined;
      if (value.endpointSet !== undefined) {
        const parsed = parseEndpointSet(value.endpointSet);
        if (parsed.kind === "malformed") return fail("invalid_response");
        if (parsed.kind === "valid") {
          if (parsed.endpointSet.endpoints.length === 0) return fail("invalid_response");
          endpointSet = parsed.endpointSet;
        }
      }
      return ok({
        url: value.url,
        hostKey: value.hostKey,
        secret: value.secret,
        expiresAt: value.expiresAt,
        ...(endpointSet === undefined ? {} : { endpointSet }),
      });
    },
    registerPushToken: async (token) => {
      const result = await request("/api/push-tokens", "POST", { apns: token.apns, environment: token.environment });
      return result.ok ? ok(undefined) : result;
    },
    removePushToken: async (token) => {
      const result = await request("/api/push-tokens/remove", "POST", { apns: token.apns, environment: token.environment });
      return result.ok ? ok(undefined) : result;
    },
  };
}

/**
 * A pairing offer as the fragment the existing flow reads — validated by the
 * same `pairingFragment` rule pasted links and deep links go through, so a
 * malformed offer is refused before a socket opens.
 */
export function accountPairingFragment(offer: PairingOffer): string | undefined {
  const endpointSet =
    offer.endpointSet === undefined ? "" : `&endpointSet=${encodeEndpointSetParam(offer.endpointSet)}`;
  return pairingFragment(
    `https://server.invalid/#pair=${offer.hostKey}.${offer.secret}&url=${encodeURIComponent(offer.url)}${endpointSet}`,
  );
}

/** How an account-bound host relates to the pairings this device stored. */
export type AccountHostStatus =
  /** A stored entry connects to it directly — either linked by account or sharing the Noise key. */
  | "paired"
  /** Nothing stored under it; an invite can be asked for (subject to `host.pairing`). */
  | "unpaired"
  /**
   * A stored entry links this serverOrigin+hostId but pins a different Noise
   * key: the host's key changed (reinstall, or worse). Report only — never
   * re-pair on the client's own initiative.
   */
  | "key_changed";

export interface AccountHostMatch {
  readonly host: AccountHost;
  readonly status: AccountHostStatus;
  /** The stored pairing behind a `paired`/`key_changed` verdict. */
  readonly stored?: StoredHost;
  /**
   * The stored entry shares the Noise key but was saved before account
   * linkage existed — the caller may persist `{...stored, account}` to adopt
   * the association. False when the match already carries the link.
   */
  readonly linkable: boolean;
  /**
   * Whether this client may register the host through the account without
   * asking the user (M8): only an unpaired host, outside the declined set,
   * when the local pairing list was actually read. A failed read is not an
   * empty list.
   */
  readonly autoRegister: boolean;
}

/**
 * One account-host identity: the server that vouches for it plus its hostId.
 * The declined set stores these so a forgotten or refused account host is not
 * silently registered again.
 */
export interface AccountHostRef {
  readonly serverOrigin: string;
  readonly hostId: string;
}

/**
 * Pair the server's account hosts against the device's stored pairings.
 * Identity is the Noise key: a stored entry whose `account` link matches
 * serverOrigin+hostId is paired (or `key_changed` when the keys diverged);
 * an unlinked entry with the same key counts as paired and may adopt the link.
 *
 * `declined` holds identities the user forgot or the host refused; `storedRead`
 * is false when the local pairing list could not be loaded, which must not be
 * mistaken for an empty list. Both only affect `autoRegister`: the verdict
 * still describes the pairing the client actually has.
 */
export function matchAccountHosts(
  serverOrigin: string,
  hosts: readonly AccountHost[],
  stored: readonly StoredHost[],
  declined: readonly AccountHostRef[],
  storedRead: boolean,
): AccountHostMatch[] {
  const origin = normalizeServerOrigin(serverOrigin);
  const declinedKeys = new Set(
    declined.map((entry) => `${normalizeServerOrigin(entry.serverOrigin)}\u0000${entry.hostId}`),
  );
  return hosts.map((host) => {
    const match = (status: AccountHostStatus, stored?: StoredHost, linkable = false): AccountHostMatch => ({
      host,
      status,
      ...(stored === undefined ? {} : { stored }),
      linkable,
      autoRegister:
        storedRead
        && status === "unpaired"
        && !declinedKeys.has(`${origin}\u0000${host.hostId}`),
    });
    // Several entries may share a link — an explicit re-pair after a key
    // change stores a fresh record without deleting the stale one. The entry
    // whose key still matches wins; only a link with no matching key at all
    // is a key_changed report.
    const linked = stored.filter(
      (each) =>
        each.account !== undefined &&
        normalizeServerOrigin(each.account.serverOrigin) === origin &&
        each.account.hostId === host.hostId,
    );
    const exact = linked.find((each) => each.hostKey === host.noisePublicKey);
    if (exact !== undefined) return match("paired", exact);
    if (linked.length > 0) return match("key_changed", linked[0]);
    const twin = stored.find((each) => each.hostKey === host.noisePublicKey);
    if (twin !== undefined) return match("paired", twin, twin.account === undefined);
    return match("unpaired");
  });
}

/** A pairing socket closed; the code distinguishes a refusal from a broken path. */
export class PairingHandshakeError extends Error {
  readonly code?: number;

  constructor(code?: number) {
    super(code === undefined ? "pairing connection closed" : `pairing connection closed (${code})`);
    this.name = "PairingHandshakeError";
    if (code !== undefined) this.code = code;
  }
}

/** A host refusal (4401) is the only close code that means "this device is not allowed". */
const rejectedPairing = (error: unknown): { code?: number } | undefined => {
  if (error instanceof PairingHandshakeError) {
    return error.code === UNAUTHORIZED_CLOSE_CODE ? { code: error.code } : undefined;
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === UNAUTHORIZED_CLOSE_CODE) return { code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b4401\b/.test(message) ? { code: UNAUTHORIZED_CLOSE_CODE } : undefined;
};

/** What pairViaAccount's connect seam runs: one secure-channel handshake. */
export interface PairConnectArgs {
  readonly url: string;
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  readonly secret: string;
  readonly name: string;
  /** Aborted when this candidate's pairing deadline expires. */
  readonly signal?: AbortSignal;
}

/**
 * The real pairing path: the same IK handshake a QR link drives, minus the
 * durable session — the offer is spent and the device registered by the time
 * the handshake completes, so the socket closes right after `onPaired`.
 */
function pairHandshake(args: PairConnectArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    let connection: FrameConnection | undefined;
    let settled = false;
    const signal = args.signal;
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      connection?.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void => finish(new Error("pairing attempt aborted"));
    if (signal?.aborted) {
      finish(new Error("pairing attempt aborted"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const transport = secureWebSocketTransport({
      url: args.url,
      hostKey: args.hostKey,
      device: args.device,
      pairing: { secret: args.secret, name: args.name },
      onPaired: () => finish(),
    });
    try {
      connection = transport.open({
        message: () => {},
        // Settled already → no-op; before onPaired it's the refusal signal.
        closed: (code) => finish(new PairingHandshakeError(code)),
      });
      // A carrier that reported a synchronous refusal before returning still
      // needs its socket closed.
      if (settled) connection.close();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface AccountPairSettings {
  /** The page's protocol, so a mixed-content candidate is skipped before dialing. */
  readonly pageProtocol?: string;
  /** Per-candidate deadline; pairing must not hang on one path. Defaults to 10s. */
  readonly attemptTimeoutMs?: number;
}

/**
 * The whole "pair this account host" action: ask the server for a vouched
 * offer, normalize it through the pairing-link rule, then try the offered
 * candidates in Auto order with one device identity and one secret. The first
 * verified message 2 ends the action — paired, not necessarily business ready.
 */
export async function pairViaAccount(
  client: AccountClient,
  hostId: string,
  name: string,
  connect: (args: PairConnectArgs) => Promise<void> = pairHandshake,
  settings: AccountPairSettings = {},
): Promise<AccountResult<StoredHost>> {
  const offer = await client.requestPairing(hostId);
  if (!offer.ok) return offer;
  const fragment = accountPairingFragment(offer.value);
  if (fragment === undefined) return fail("invalid_offer");
  const params = new URLSearchParams(fragment);
  const pair = parsePairParam(params.get("pair")!);
  const url = params.get("url");
  if (pair === undefined || url === null) return fail("invalid_offer");
  const hostKey = fromBase64Url(pair.hostKey);
  const device = generateKeyPair();
  const planned = candidatePlan(url, offer.value.endpointSet, { pageProtocol: settings.pageProtocol });
  const diagnostics: (PairCandidateDiagnostic | undefined)[] = planned.map((candidate) =>
    candidate.unsupported === undefined
      ? undefined
      : {
          url: candidate.url,
          role: candidate.role,
          outcome: "unsupported",
          reason: candidate.unsupported,
        },
  );
  const candidates = planned.filter((candidate) => candidate.unsupported === undefined);
  const orderedDiagnostics = (): PairCandidateDiagnostic[] =>
    diagnostics.filter((diagnostic): diagnostic is PairCandidateDiagnostic => diagnostic !== undefined);
  if (candidates.length === 0) return pairFailure(orderedDiagnostics());
  const timeoutMs = settings.attemptTimeoutMs ?? 10_000;
  let paired = false;
  for (let index = 0; index < planned.length; index++) {
    const candidate = planned[index]!;
    if (candidate.unsupported !== undefined) continue;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("pairing attempt aborted")), { once: true });
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("pairing attempt timed out"));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        connect({ url: candidate.url, hostKey, device, secret: pair.secret, name, signal: controller.signal }),
        aborted,
        deadline,
      ]);
      paired = true;
      break;
    } catch (error) {
      // This path failed; a later candidate shares the same device and secret
      // until message 2 verifies (ADR-0032 §4). Keep the per-path evidence:
      // only a real 4401 is a refusal, and a timeout is not a host outage.
      if (timedOut) {
        diagnostics[index] = {
          url: candidate.url,
          role: candidate.role,
          outcome: "timeout",
          reason: `no answer within ${timeoutMs}ms`,
        };
      } else {
        const rejected = rejectedPairing(error);
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics[index] =
          rejected === undefined
            ? { url: candidate.url, role: candidate.role, outcome: "unreachable", reason }
            : {
                url: candidate.url,
                role: candidate.role,
                outcome: "rejected",
                reason,
                ...(rejected.code === undefined ? {} : { code: rejected.code }),
              };
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
  if (!paired) return pairFailure(orderedDiagnostics());
  const endpointSet = offer.value.endpointSet;
  return ok({
    url: endpointSet === undefined ? url : preferredLegacyUrl(url, endpointSet),
    hostKey: pair.hostKey,
    privateKey: toBase64Url(device.privateKey),
    // `vouched`: the key came from the account's offer, unlike a link the
    // client adopts later onto a QR pairing (#494).
    account: { serverOrigin: client.origin, hostId, vouched: true },
    ...(endpointSet === undefined ? {} : { endpointSet }),
  });
}
