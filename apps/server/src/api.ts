// The server's HTTP account API (ADR-0022 §2), mounted on the same port as the
// splice sockets and the static web client: GET /api/auth/methods, POST
// /api/login (email or legacy username), email sign-up with POST
// /api/register/code then POST /api/register, password reset with POST
// /api/password/reset/code then POST /api/password/reset, and a signed-in
// account's POST /api/me/email/code then POST /api/me/email (ADR-0044);
// POST /api/logout (`{ revoke: true }` also takes this device off its hosts, #494),
// POST /api/sessions/revoke-all, GET /api/me, POST /api/password (#450),
// POST /api/me/delete (#451), GET /api/devices and POST /api/devices/:id/kick
// (ADR-0037), POST /api/hosts/:hostId/remove (#512),
// POST /api/join-tokens, POST /api/push-tokens and POST /api/push-tokens/remove
// (ADR-0036). Host links (#495, RFC 8628) put a device
// code in front of the join token: the host CLI calls POST /api/host-link/start
// and /poll with no credential, a signed-in user POST /api/host-link/lookup,
// /confirm and /deny. A host that can open a browser on its own screen asks
// for a loopback redirect instead (#513, RFC 8252): the confirm page names
// the request by id, sends the browser back to the host's 127.0.0.1 listener
// with a one-time code, and the host trades it at POST /api/host-link/token
// with its PKCE verifier.
//
// Sign-in with Google, GitHub and Apple (ADR-0044 §3–§5): GET
// /api/oauth/:provider/start sends the browser to the provider, whose
// callback (GET, or Apple's form_post) lands the account, a "no account yet"
// choice (GET /api/oauth/pending/:id, then POST …/create or …/link), or for
// native clients a one-time code they trade at POST /api/oauth/token; iOS's
// own Sign in with Apple posts to /api/oauth/apple/native. Signed in, POST
// /api/oauth/:provider/link adds a provider, GET /api/me/identities lists
// them and POST /api/me/identities/:provider/remove unlinks one. POST
// /api/reauth (after POST /api/reauth/code for a mailed code) grants the
// confirmation that kicking a device, removing a host, deleting the account
// and changing the password take instead of the password (§6).
//
// Two credential styles share the routes, decided by the request's Origin:
// the same-origin web client gets a Secure+HttpOnly+SameSite=Strict host-only
// cookie (mutating requests then must carry that Origin), while the desktop
// app (app://pinomad) and Origin-less native clients get the bare token for
// `Authorization: Bearer`. Bearer requests have no ambient credential, so the
// Origin check doesn't apply to them; CORS is emitted only for the desktop
// origin, and never with credentials.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import { relayWsBase } from "@pinomad/host/src/relay-link.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MAX_PASSWORD_CODEPOINTS,
  MAX_USERNAME_CODEPOINTS,
  normalizeApnsToken,
  normalizeEmail,
  parseDeviceClaim,
  type AccountUser,
  type Accounts,
  type Confirmation,
  type NativeRedirect,
  type PendingCompletion,
  type PendingResult,
  type HostLinkLoopback,
  type HostLinkRef,
  type SendCodeResult,
} from "./accounts.ts";
import { OAUTH_PROVIDERS, type OAuthProvider, type OAuthProviders } from "./oauth.ts";

/** Whether a bound host can serve a pairing ask right now (ADR-0022 §4). */
export type PairingStatus = "available" | "offline" | "host_too_old" | "key_mismatch";

/**
 * The outcome of asking a host for a pairing offer over its control
 * connection: "gone" means the asking control vanished mid-flight (or was
 * never there), "cancelled" that the HTTP client went away first.
 */
export type PairingRequestResult =
  | {
      readonly status: "ok";
      /** The server's id for this ask; the host's device-admitted report names it (ADR-0037 §2). */
      readonly requestId: string;
      readonly secret: string;
      readonly expiresAt: number;
      /** Forwarded from the host's answer; never stored server-side. */
      readonly endpointSet?: EndpointSet;
    }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "gone" }
  | { readonly status: "timeout" }
  | { readonly status: "too_many" }
  | { readonly status: "cancelled" };

/**
 * The transport's view of server-vouched pairing: liveness and capability of
 * a host's control connection, and a way to ask it for an offer. Implemented
 * in relay.ts where the control sockets live.
 */
export interface PairingBroker {
  status(hostId: string, boundNoiseKey: string): PairingStatus;
  request(hostId: string, sessionKey: string, signal: AbortSignal): Promise<PairingRequestResult>;
}

export interface ApiContext {
  readonly accounts: Accounts;
  /** The origin browsers open the server under; Origin headers must match it. */
  readonly publicOrigin: string;
  /** Only set behind a TLS-terminating proxy — enables trusting X-Forwarded-*. */
  readonly trustProxy: boolean;
  /** Server-vouched pairing (ADR-0022 §4) for /api/hosts. */
  readonly pairing: PairingBroker;
  /** Closes a host's control connection once its account binding is gone; `removed` when the account removed it (#512). */
  readonly disconnectHost: (hostId: string, removed?: boolean) => void;
  /** Drops a deleted account's relay limit state: users.id is reusable, so a new account must not inherit it (#453). */
  readonly forgetAccount: (userId: number) => void;
  /**
   * Sends a host's pending revocations over its control connection when it is
   * online and declared "device-reports" (ADR-0037 §3); otherwise they wait
   * for its next register.
   */
  readonly sendRevocations: (hostId: string) => void;
  /** The configured sign-in providers (ADR-0044 §3); absent → none. */
  readonly oauth?: OAuthProviders;
}

const SESSION_COOKIE = "__Host-pinomad-session";
// A hostId is base64url of 32 bytes, as in the /api/hosts/:hostId routes.
const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636: S256 challenges are 43 base64url characters; verifiers 43–128 unreserved ones.
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const LOOPBACK_STATE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REDIRECT_URI = 256;

/**
 * A loopback host link's fields (#513), or null when any is off. The redirect
 * is the whole security argument, so it is exactly `http://127.0.0.1:<port>`
 * plus a path: not `localhost` (DNS can point it elsewhere), no userinfo,
 * query or fragment, and only in the form the URL parser writes back.
 */
function parseLoopback(value: { redirectUri?: unknown; codeChallenge?: unknown; state?: unknown }): HostLinkLoopback | null {
  const { redirectUri, codeChallenge, state } = value;
  if (typeof redirectUri !== "string" || redirectUri.length > MAX_REDIRECT_URI) return null;
  if (typeof codeChallenge !== "string" || !PKCE_CHALLENGE.test(codeChallenge)) return null;
  if (typeof state !== "string" || !LOOPBACK_STATE.test(state)) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  const loopbackOnly =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === redirectUri;
  return loopbackOnly ? { redirectUri, codeChallenge, state } : null;
}
/**
 * A native client's redirect for a provider sign-in (ADR-0044 §5), or null
 * when any field is off: exactly `pinomad://auth` (iOS), or the desktop's
 * listener at `http://127.0.0.1:<port>` with no path, `/` or `/callback` —
 * never `localhost`, which DNS can point elsewhere.
 */
function parseNativeRedirect(redirectUri: string | null, codeChallenge: string | null, state: string | null): NativeRedirect | null {
  if (redirectUri === null || codeChallenge === null || state === null) return null;
  if (!PKCE_CHALLENGE.test(codeChallenge) || !LOOPBACK_STATE.test(state)) return null;
  const loopback = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(?:\/|\/callback)?$/.exec(redirectUri);
  const allowed = redirectUri === "pinomad://auth" || (loopback !== null && Number(loopback[1]) <= 65535);
  return allowed ? { redirectUri, codeChallenge, state } : null;
}

/** The redirect with `params` added; the allowed redirects carry no query of their own. */
const withParams = (redirectUri: string, params: Record<string, string>): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

const MAX_BODY = 8 * 1024;
// A mailed code is six digits; anything much longer is not a typo of one.
const MAX_CODE_LENGTH = 32;

/**
 * The anonymous routes that also answer desktop and Origin-less native
 * callers (ADR-0044 §5): they carry no ambient credential, so there is
 * nothing for a foreign page to forge beyond what it could send itself.
 */
const ANONYMOUS_ACCOUNT_ROUTES = new Set([
  "/api/login",
  "/api/register/code",
  "/api/register",
  "/api/password/reset/code",
  "/api/password/reset",
]);

/** A body's `email`, normalized; undefined when missing or not an email. */
const bodyEmail = (value: unknown): string | undefined => {
  const email = (value as { email?: unknown } | null)?.email;
  return typeof email === "string" && email.length <= 1024 ? normalizeEmail(email) : undefined;
};

/** A body's `code`, as typed; undefined when missing or far too long. */
const bodyCode = (value: unknown): string | undefined => {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length <= MAX_CODE_LENGTH ? code : undefined;
};
/**
 * The provider sign-in routes that, like login, answer desktop and
 * Origin-less native callers in token mode (ADR-0044 §5): trading a one-time
 * code, iOS's own Apple sign-in, and finishing a native client's pending
 * sign-in, whose id is the bearer secret.
 */
const OAUTH_TOKEN_ROUTE = /^\/api\/oauth\/(?:token|apple\/native|pending\/[A-Za-z0-9_-]{43}\/(?:create|link))$/;

/** A body's `{ password }` or `{ reauth }` (ADR-0044 §6), the grant tied to `token`; undefined when neither or both. */
function bodyConfirmation(value: unknown, token: string): Confirmation | undefined {
  const { password, reauth } = (typeof value === "object" && value !== null ? value : {}) as { password?: unknown; reauth?: unknown };
  if (typeof reauth === "string" && password === undefined) return reauth.length <= 256 ? { reauth, token } : undefined;
  if (typeof password === "string" && reauth === undefined) return [...password].length <= MAX_PASSWORD_CODEPOINTS ? { password } : undefined;
  return undefined;
}

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// The desktop renderer's origin — apps/desktop/electron/renderer-files.ts
// defines APP_SCHEME/APP_HOST. Kept a literal on purpose: the relay must not
// depend on the desktop package.
const DESKTOP_ORIGIN = "app://pinomad";

const isLoopback = (address: string | undefined): boolean =>
  address !== undefined && (address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127."));

/**
 * Account traffic is TLS-only (ADR-0022): the server itself speaks plain HTTP
 * behind a terminator, so under --trust-proxy the forwarded proto decides;
 * without it only loopback plaintext (local development) is allowed.
 */
export function secureTransport(request: IncomingMessage, trustProxy: boolean): boolean {
  if (trustProxy) return request.headers["x-forwarded-proto"] === "https";
  return isLoopback(request.socket.remoteAddress);
}

/** The address rate limits key on — X-Forwarded-For only counts when the proxy is trusted. */
function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

// Bodies are JSON values; /api/hosts legitimately answers with an array.
function respond(response: ServerResponse, status: number, body?: unknown, headers?: Record<string, string>): void {
  const all: Record<string, string> = { ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  response.writeHead(status, all);
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

/**
 * Reads the request body fully; "too-large" drains the rest so the 413 still
 * reaches the client. With `optional`, an empty body reads as `undefined`
 * rather than invalid JSON.
 */
async function readJson(
  request: IncomingMessage,
  optional = false,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) {
      tooLarge = true;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) return { ok: false, tooLarge: true };
  if (optional && size === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

type Session = NonNullable<ReturnType<Accounts["authenticate"]>>;

/**
 * Reads a signed-in route's body, then authenticates `token` again: the
 * caller can hold the body back while the session is revoked, kicked or
 * deleted elsewhere (CWE-367), so the route must act on the session as it
 * stands now. Every signed-in route that reads a body goes through this;
 * test/api-reauth.test.ts holds the rule.
 */
async function authedJson(
  accounts: Accounts,
  request: IncomingMessage,
  token: string,
  optional = false,
): Promise<
  | { readonly ok: true; readonly value: unknown; readonly session: Session }
  | { readonly ok: false; readonly status: number; readonly error: string }
> {
  const body = await readJson(request, optional);
  if (!body.ok) return { ok: false, status: body.tooLarge ? 413 : 400, error: body.tooLarge ? "payload_too_large" : "invalid_json" };
  const session = accounts.authenticate(token);
  if (session === undefined) return { ok: false, status: 401, error: "unauthenticated" };
  return { ok: true, value: body.value, session };
}

/** A request cookie's value. */
function cookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Bearer token first, then the browser session cookie. */
function sessionToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return cookie(request, SESSION_COOKIE);
}

const cookieAttributes = "Path=/; Secure; HttpOnly; SameSite=Strict";
const setSessionCookie = (token: string): string => `${SESSION_COOKIE}=${token}; ${cookieAttributes}`;
const clearSessionCookie = `${SESSION_COOKIE}=; ${cookieAttributes}; Max-Age=0`;

/**
 * Binds a provider sign-in to the browser that started it (ADR-0044 §5):
 * the flow stores this cookie's hash and the callback must bring it, so
 * nobody can finish their own sign-in in someone else's browser. Apple's
 * callback is a cross-site POST, hence SameSite=None. `__Host-` with Path=/
 * and no Domain: a sibling subdomain can't plant its own flow's value.
 */
const BINDING_COOKIE = "__Host-pinomad-oauth";
const bindingAttributes = "Path=/; Secure; HttpOnly; SameSite=None";
const setBindingCookie = (value: string): string => `${BINDING_COOKIE}=${value}; ${bindingAttributes}; Max-Age=600`;
const clearBindingCookie = `${BINDING_COOKIE}=; ${bindingAttributes}; Max-Age=0`;

/** Whether this request carries the binding a web flow or pending sign-in was started with. */
const bound = (request: IncomingMessage, bindingHash: string | undefined): boolean => {
  const value = cookie(request, BINDING_COOKIE);
  return value !== undefined && bindingHash !== undefined && sameHash(sha256Hex(value), bindingHash);
};

/** Reads a urlencoded form body (Apple's form_post), bounded like JSON bodies. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  return size > MAX_BODY ? undefined : new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse, ctx: ApiContext): Promise<void> {
  const { accounts } = ctx;
  const origin = request.headers.origin;
  const method = request.method ?? "";

  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://server.invalid").pathname;
  } catch {
    pathname = "";
  }

  // The desktop renderer is the only known cross-origin client; ACAO on its
  // API responses lets Chromium hand them to the app.
  const cors: Record<string, string> =
    origin === DESKTOP_ORIGIN ? { "access-control-allow-origin": DESKTOP_ORIGIN, vary: "Origin" } : {};
  const send = (status: number, body?: unknown, headers?: Record<string, string>): void =>
    respond(response, status, body, { ...cors, ...headers });
  const deny = (status: number, error: string, headers?: Record<string, string>): void =>
    send(status, { error }, headers);
  /**
   * The account as /api/me and sign-ins show it: `needsEmail` asks a legacy
   * account for an email, only when the server can mail it a code (ADR-0044 §8).
   */
  const profile = (user: AccountUser): Record<string, unknown> => ({
    user,
    ...(user.email === undefined && accounts.emailEnabled ? { needsEmail: true } : {}),
  });
  /**
   * A new session: same-origin browser sessions ride the HttpOnly cookie —
   * the token never enters a body the page's JS could read. Desktop/native
   * callers get the bare token for secure storage and no cookie.
   */
  const signedIn = (session: { readonly token: string; readonly expiresAt: number; readonly user: AccountUser }): void => {
    const cookieMode = origin === ctx.publicOrigin;
    send(
      200,
      { ...profile(session.user), expiresAt: session.expiresAt, ...(cookieMode ? {} : { token: session.token }) },
      cookieMode ? { "set-cookie": setSessionCookie(session.token) } : undefined,
    );
  };
  /** Asked for a mailed code: 202 with no body whether or not a mail went out. */
  const codeSent = (result: SendCodeResult, closed: string): void => {
    if (result === "limited") deny(429, "rate_limited");
    else if (result === "closed") deny(403, closed);
    else if (result === "taken") deny(409, "email_taken");
    // 403, not 401: a mistyped password must not read as signed out.
    else if (result === "wrong_password" || result === "invalid_reauth") deny(403, result);
    else send(202);
  };

  if (!secureTransport(request, ctx.trustProxy)) {
    deny(403, "https_required");
    return;
  }

  // CORS preflight: only the desktop origin gets allow-headers; nothing else
  // is a legitimate cross-origin caller.
  if (method === "OPTIONS") {
    send(204, undefined, origin === DESKTOP_ORIGIN ? {
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "authorization, content-type",
    } : {});
    return;
  }

  // A Bearer request carries its own credential, so no Origin check. Anything
  // else that mutates (the ambient-cookie path, or an anonymous probe) must be
  // same-origin — except login, sign-up and password reset, which also answer
  // desktop and Origin-less native callers in token mode (their branch picks
  // the response style).
  const bearer = (request.headers.authorization ?? "").startsWith("Bearer ");
  const loginTokenMode =
    (ANONYMOUS_ACCOUNT_ROUTES.has(pathname) || OAUTH_TOKEN_ROUTE.test(pathname)) && (origin === undefined || origin === DESKTOP_ORIGIN);
  // Apple's callback is a cross-site form POST from appleid.apple.com. It
  // carries no session credential: the flow's binding (cookie or PKCE) is
  // what ties it to whoever started the sign-in.
  const appleFormPost = pathname === "/api/oauth/apple/callback";
  // The host CLI starts and polls a host link with no credential at all, so
  // there is nothing to forge; it sends no Origin, and only that is let past.
  const hostLinkHostMode =
    (pathname === "/api/host-link/start" || pathname === "/api/host-link/poll" || pathname === "/api/host-link/token") &&
    origin === undefined;
  if (MUTATING.has(method) && !bearer && !loginTokenMode && !hostLinkHostMode && !appleFormPost && origin !== ctx.publicOrigin) {
    deny(403, "origin_mismatch");
    return;
  }

  if (pathname === "/api/login") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const value = body.value;
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { username?: unknown }).username !== "string" ||
      typeof (value as { password?: unknown }).password !== "string"
    ) {
      deny(400, "invalid_request");
      return;
    }
    const { username, password } = value as { username: string; password: string };
    // Optional and additive (ADR-0037 §1): older clients send none, and an
    // older server ignores it. A malformed one is a client bug, refused
    // rather than silently turned into an unnamed device.
    const device = parseDeviceClaim((value as { device?: unknown }).device);
    // Same bounds the account layer enforces at creation (accounts.ts) — a
    // field outside them can never match a stored credential.
    if (
      [...username].length === 0 ||
      [...username].length > MAX_USERNAME_CODEPOINTS ||
      [...password].length > MAX_PASSWORD_CODEPOINTS ||
      device === "invalid"
    ) {
      deny(400, "invalid_request");
      return;
    }
    const result = await accounts.login(username, password, clientIp(request, ctx.trustProxy), device);
    if (result.status === "limited") {
      deny(429, "rate_limited");
      return;
    }
    if (result.status === "invalid") {
      deny(401, "invalid_credentials");
      return;
    }
    signedIn(result);
    return;
  }

  if (pathname === "/api/auth/methods") {
    if (method !== "GET") {
      deny(405, "method_not_allowed", { allow: "GET" });
      return;
    }
    send(200, { registration: accounts.registrationOpen, email: accounts.emailEnabled, providers: ctx.oauth?.enabled ?? [] });
    return;
  }

  const oauth = ctx.oauth;
  /** A configured provider by the name in the path. */
  const enabledProvider = (name: string | undefined): OAuthProvider | undefined => oauth?.enabled.find((provider) => provider === name);
  const callbackUri = (provider: OAuthProvider): string => `${ctx.publicOrigin}/api/oauth/${provider}/callback`;
  /** Sends the browser on; provider sign-ins answer navigations, not fetches. */
  const redirect = (to: string, cookies: readonly string[] = []): void => {
    response.writeHead(302, { location: to, ...(cookies.length === 0 ? {} : { "set-cookie": [...cookies] }) });
    response.end();
  };
  /** The web client, told how a provider sign-in ended. */
  const toWebClient = (param: "oauth_error" | "oauth_pending" | "oauth_linked", value: string, cookies?: readonly string[]): void =>
    redirect(`${ctx.publicOrigin}/?${new URLSearchParams({ [param]: value })}`, cookies);
  /** A one-time code for a native client's redirect (ADR-0044 §5). */
  const nativeCode = (userId: number, native: NativeRedirect): string =>
    withParams(native.redirectUri, { code: accounts.issueOAuthCode(userId, native.codeChallenge), state: native.state });
  /** A finished pending sign-in or link refused: the reason, with the status its kind of refusal takes. */
  const pendingRefused = (result: Exclude<PendingResult, { status: "ok" }>): void => {
    if (result.status === "limited") {
      deny(429, "rate_limited");
      return;
    }
    const status = {
      not_found: 404,
      registration_closed: 403,
      no_verified_email: 400,
      email_taken: 409,
      identity_taken: 409,
      password_required: 400,
      weak_password: 400,
    }[result.reason];
    deny(status, result.reason);
  };

  const providerRoute = /^\/api\/oauth\/([a-z]+)\/(start|callback)$/.exec(pathname);
  if (providerRoute !== null) {
    const provider = enabledProvider(providerRoute[1]);
    const expected = providerRoute[2] === "callback" && provider === "apple" ? "POST" : "GET";
    if (provider === undefined) {
      deny(404, "not_found");
      return;
    }
    if (method !== expected) {
      deny(405, "method_not_allowed", { allow: expected });
      return;
    }
    if (providerRoute[2] === "start") {
      const query = new URL(request.url ?? "/", "http://server.invalid").searchParams;
      const client = query.get("client") ?? "web";
      const native = client === "native" ? parseNativeRedirect(query.get("redirect_uri"), query.get("code_challenge"), query.get("state")) : undefined;
      if ((client !== "web" && client !== "native") || native === null) {
        deny(400, "invalid_request");
        return;
      }
      // A native app's flow runs in a browser too (the system browser,
      // ASWebAuthenticationSession), and is bound to it like a web one.
      const binding = randomBytes(32).toString("base64url");
      const flow = accounts.startOAuthFlow({
        provider,
        kind: native === undefined ? "web" : "native",
        ip: clientIp(request, ctx.trustProxy),
        bindingHash: sha256Hex(binding),
        ...(native === undefined ? {} : { native }),
      });
      if (flow.status === "limited") deny(429, "rate_limited");
      else if (flow.status === "busy") deny(503, "busy");
      else {
        const to = oauth!.authorizeUrl(provider, {
          state: flow.state,
          nonce: flow.nonce,
          codeChallenge: pkceChallenge(flow.verifier),
          redirectUri: callbackUri(provider),
        });
        redirect(to, [setBindingCookie(binding)]);
      }
      return;
    }
    const params = method === "POST" ? await readForm(request) : new URL(request.url ?? "/", "http://server.invalid").searchParams;
    const state = params?.get("state");
    const flow = state === null || state === undefined || state.length > 256 ? undefined : accounts.takeOAuthFlow(provider, state);
    if (flow === undefined) {
      toWebClient("oauth_error", "invalid_state");
      return;
    }
    const fail = (reason: string): void => {
      if (flow.native === undefined) toWebClient("oauth_error", reason);
      else redirect(withParams(flow.native.redirectUri, { error: reason, state: flow.native.state }));
    };
    // Login CSRF: a flow only finishes in the browser that started it.
    if (!bound(request, flow.bindingHash)) {
      fail("invalid_state");
      return;
    }
    const code = params!.get("code");
    if (params!.get("error") !== null || code === null) {
      fail(params!.get("error") === null ? "invalid_request" : "access_denied");
      return;
    }
    const identity = await oauth!.exchange(provider, {
      code,
      verifier: flow.verifier,
      nonce: flow.nonce,
      redirectUri: callbackUri(provider),
      ...(params!.get("user") === null ? {} : { user: params!.get("user")! }),
    });
    if ("error" in identity) {
      fail(identity.error);
      return;
    }
    if (flow.kind === "link") {
      // Re-checked with the write: the session that started the link may
      // have been signed out, or the password reset, while the provider's
      // pages were open.
      const linked =
        flow.linkUserId === undefined || flow.linkSessionHash === undefined
          ? "session_ended"
          : accounts.linkIdentity({ linkUserId: flow.linkUserId, linkSessionHash: flow.linkSessionHash }, identity);
      if (linked !== "linked") fail(linked);
      else toWebClient("oauth_linked", provider, [clearBindingCookie]);
      return;
    }
    const completion: PendingCompletion =
      flow.native === undefined
        ? { kind: "web", bindingHash: flow.bindingHash! }
        : { kind: "native", bindingHash: flow.bindingHash!, native: flow.native };
    const resolved = accounts.resolveIdentity(identity, completion);
    if (resolved.status === "refused") {
      fail(resolved.reason);
      return;
    }
    // The "no account yet" page is the web client's, for native flows too:
    // the person is still in the browser the client opened.
    // The binding cookie is renewed for the pending record's ten minutes,
    // however long the provider's pages took.
    if (resolved.status === "pending") {
      toWebClient("oauth_pending", resolved.id, [setBindingCookie(cookie(request, BINDING_COOKIE)!)]);
      return;
    }
    if (flow.native !== undefined) {
      redirect(nativeCode(resolved.userId, flow.native));
      return;
    }
    const session = accounts.signIn(resolved.userId);
    if (session === undefined) fail("not_found");
    else redirect(`${ctx.publicOrigin}/`, [setSessionCookie(session.token), clearBindingCookie]);
    return;
  }

  if (pathname === "/api/oauth/token" || pathname === "/api/oauth/apple/native") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    if (pathname === "/api/oauth/apple/native" && oauth?.appleNative !== true) {
      deny(404, "not_found");
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const value = (typeof body.value === "object" && body.value !== null ? body.value : {}) as Record<string, unknown>;
    const device = parseDeviceClaim(value.device);
    if (device === "invalid") {
      deny(400, "invalid_request");
      return;
    }
    if (pathname === "/api/oauth/token") {
      const { code, code_verifier: verifier } = value;
      if (typeof code !== "string" || code.length > 256 || typeof verifier !== "string" || !PKCE_VERIFIER.test(verifier)) {
        deny(400, "invalid_request");
        return;
      }
      const session = accounts.exchangeOAuthCode(code, verifier, device);
      // RFC 6749 §5.2: a spent, expired or mismatched code is invalid_grant.
      if (session === undefined) deny(400, "invalid_grant");
      else signedIn(session);
      return;
    }
    const { identityToken, authorizationCode, nonce, name } = value;
    if (
      typeof identityToken !== "string" ||
      typeof authorizationCode !== "string" ||
      authorizationCode.length > 1024 ||
      (nonce !== undefined && (typeof nonce !== "string" || nonce.length > 256)) ||
      (name !== undefined && typeof name !== "string")
    ) {
      deny(400, "invalid_request");
      return;
    }
    const identity = await oauth!.verifyAppleNative({
      identityToken,
      authorizationCode,
      ...(nonce === undefined ? {} : { nonce }),
      ...(name === undefined ? {} : { name }),
    });
    if ("error" in identity) {
      deny(identity.error === "invalid_token" ? 401 : 400, identity.error === "invalid_token" ? "invalid_token" : "invalid_grant");
      return;
    }
    const resolved = accounts.resolveIdentity(identity, { kind: "direct" });
    if (resolved.status === "refused") deny(403, resolved.reason);
    // iOS shows its own "no account yet" choice, then finishes through the
    // pending routes.
    else if (resolved.status === "pending") {
      send(409, { error: "no_account", reason: "no_account", pending: resolved.id, ...(resolved.email === undefined ? {} : { email: resolved.email }) });
    } else {
      const session = accounts.signIn(resolved.userId, device);
      if (session === undefined) deny(404, "not_found");
      else signedIn(session);
    }
    return;
  }

  const pendingRoute = /^\/api\/oauth\/pending\/([A-Za-z0-9_-]{43})(?:\/(create|link))?$/.exec(pathname);
  if (pendingRoute !== null) {
    const id = pendingRoute[1]!;
    const action = pendingRoute[2];
    const expected = action === undefined ? "GET" : "POST";
    if (method !== expected) {
      deny(405, "method_not_allowed", { allow: expected });
      return;
    }
    /**
     * The pending sign-in, when this caller may act on it. One from a browser
     * flow only in that browser. One from iOS's own Apple sign-in has no
     * browser, so its id is the app's bearer secret: only the app's own
     * calls may use it — token mode to read or create, a Bearer session to
     * link — never a cookie session or the web origin, which a link someone
     * was sent could drive (the stranger's identity on their account).
     */
    const visible = () => {
      const pending = accounts.pendingSignIn(id);
      if (pending === undefined) return undefined;
      const { completion } = pending;
      if (completion.kind !== "direct") return bound(request, completion.bindingHash) ? pending : undefined;
      const tokenMode = (origin === undefined || origin === DESKTOP_ORIGIN) && cookie(request, SESSION_COOKIE) === undefined;
      return (action === "link" ? bearer : tokenMode) ? pending : undefined;
    };
    if (action === undefined) {
      const pending = visible();
      if (pending === undefined) deny(404, "not_found");
      else {
        send(200, {
          provider: pending.provider,
          ...(pending.email === undefined ? {} : { email: pending.email }),
          ...(pending.name === undefined ? {} : { name: pending.name }),
        });
      }
      return;
    }
    if (action === "create") {
      const body = await readJson(request, true);
      if (!body.ok) {
        deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
        return;
      }
      const value = body.value as { device?: unknown; password?: unknown } | undefined;
      const device = parseDeviceClaim(value?.device);
      // A server that can't mail re-auth codes needs one (ADR-0044 §6).
      const password = value?.password;
      if (device === "invalid" || (password !== undefined && (typeof password !== "string" || [...password].length > MAX_PASSWORD_CODEPOINTS))) {
        deny(400, "invalid_request");
        return;
      }
      if (visible() === undefined) {
        deny(404, "not_found");
        return;
      }
      const result = await accounts.createFromPending(id, password);
      if (result.status !== "ok") {
        pendingRefused(result);
        return;
      }
      if (result.completion.kind === "native") {
        send(200, { redirect: nativeCode(result.userId, result.completion.native) });
        return;
      }
      // Lands signed in, in the style the caller would get from login: the
      // web client's cookie, or iOS's token.
      const session = accounts.signIn(result.userId, device);
      if (session === undefined) deny(404, "not_found");
      else signedIn(session);
      return;
    }
    const token = sessionToken(request);
    if (token === undefined || accounts.authenticate(token) === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    const body = await authedJson(accounts, request, token, true);
    if (!body.ok) {
      deny(body.status, body.error);
      return;
    }
    // Confirmed like linking from settings: a session alone is not proof
    // that its owner just signed in, and a stolen one must not be able to
    // add a way back in that outlives it.
    const confirmation = bodyConfirmation(body.value, token);
    if (confirmation === undefined) {
      deny(400, "invalid_request");
      return;
    }
    if (visible() === undefined) {
      deny(404, "not_found");
      return;
    }
    const confirmed = await accounts.confirm(body.session.userId, confirmation);
    if (confirmed !== "ok") {
      deny(confirmed === "limited" ? 429 : 403, confirmed === "limited" ? "rate_limited" : confirmed);
      return;
    }
    // The session may have ended while the password was checked.
    if (accounts.authenticate(token)?.userId !== body.session.userId) {
      deny(401, "unauthenticated");
      return;
    }
    const result = accounts.linkPending(id, body.session.userId);
    if (result.status !== "ok") pendingRefused(result);
    // A native client still waits at its redirect, for a session of the
    // account it was linked to.
    else if (result.completion.kind === "native") send(200, { redirect: nativeCode(result.userId, result.completion.native) });
    else send(204);
    return;
  }

  const linkRoute = /^\/api\/oauth\/([a-z]+)\/link$/.exec(pathname);
  const removeRoute = /^\/api\/me\/identities\/([a-z]+)\/remove$/.exec(pathname);
  if (pathname === "/api/me/identities" || pathname === "/api/reauth/code" || pathname === "/api/reauth" || linkRoute !== null || removeRoute !== null) {
    const expected = pathname === "/api/me/identities" ? "GET" : "POST";
    if (method !== expected) {
      deny(405, "method_not_allowed", { allow: expected });
      return;
    }
    const token = sessionToken(request);
    const session = token === undefined ? undefined : accounts.authenticate(token);
    if (session === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    if (pathname === "/api/me/identities") {
      send(200, accounts.listIdentities(session.userId));
      return;
    }
    const body = await authedJson(accounts, request, token!, true);
    if (!body.ok) {
      deny(body.status, body.error);
      return;
    }
    const current = body.session;
    if (pathname === "/api/reauth/code") {
      const result = accounts.requestReauthCode({ userId: current.userId, ip: clientIp(request, ctx.trustProxy) });
      if (result === "no_email") deny(409, "no_email");
      else codeSent(result, "email_unavailable");
      return;
    }
    if (pathname === "/api/reauth") {
      const { password, code } = (typeof body.value === "object" && body.value !== null ? body.value : {}) as { password?: unknown; code?: unknown };
      const proof =
        typeof password === "string" && code === undefined && [...password].length <= MAX_PASSWORD_CODEPOINTS
          ? { password }
          : typeof code === "string" && password === undefined && code.length <= MAX_CODE_LENGTH
            ? { code }
            : undefined;
      if (proof === undefined) {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.grantReauth({ userId: current.userId, token: token!, ...proof });
      if (result.status === "limited") deny(429, "rate_limited");
      else if (result.status === "refused") deny(result.reason === "unauthenticated" ? 401 : 403, result.reason);
      else send(200, { reauth: result.reauth, expiresAt: result.expiresAt });
      return;
    }
    const confirmation = bodyConfirmation(body.value, token!);
    if (confirmation === undefined) {
      deny(400, "invalid_request");
      return;
    }
    if (removeRoute !== null) {
      const provider = OAUTH_PROVIDERS.find((name) => name === removeRoute[1]);
      if (provider === undefined) {
        deny(404, "not_found");
        return;
      }
      const result = await accounts.removeIdentity({ userId: current.userId, provider, ...confirmation });
      if (result.status === "limited") deny(429, "rate_limited");
      else if (result.status === "refused") {
        deny(result.reason === "not_found" ? 404 : result.reason === "last_method" ? 409 : 403, result.reason);
      } else {
        for (const grant of result.appleGrants) oauth?.revokeApple(grant.refreshToken, grant.clientId);
        send(204);
      }
      return;
    }
    // Linking from settings: the provider's answer is bound to this browser
    // like a web sign-in, and lands on this account.
    const provider = enabledProvider(linkRoute![1]);
    if (provider === undefined) {
      deny(404, "not_found");
      return;
    }
    const confirmed = await accounts.confirm(current.userId, confirmation);
    if (confirmed !== "ok") {
      deny(confirmed === "limited" ? 429 : 403, confirmed === "limited" ? "rate_limited" : confirmed);
      return;
    }
    const binding = randomBytes(32).toString("base64url");
    const flow = accounts.startOAuthFlow({
      provider,
      kind: "link",
      ip: clientIp(request, ctx.trustProxy),
      bindingHash: sha256Hex(binding),
      linkUserId: current.userId,
      linkSessionToken: token!,
    });
    if (flow.status === "limited") deny(429, "rate_limited");
    else if (flow.status === "busy") deny(503, "busy");
    else {
      const url = oauth!.authorizeUrl(provider, {
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: pkceChallenge(flow.verifier),
        redirectUri: callbackUri(provider),
      });
      send(200, { url }, { "set-cookie": setBindingCookie(binding) });
    }
    return;
  }

  if (pathname === "/api/register/code" || pathname === "/api/password/reset/code") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const email = bodyEmail(body.value);
    if (email === undefined) {
      deny(400, "invalid_email");
      return;
    }
    const args = { email, ip: clientIp(request, ctx.trustProxy) };
    const signup = pathname === "/api/register/code";
    codeSent(
      signup ? accounts.requestSignupCode(args) : accounts.requestPasswordReset(args),
      signup ? "registration_closed" : "email_unavailable",
    );
    return;
  }

  if (pathname === "/api/register" || pathname === "/api/password/reset") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const value = body.value as { password?: unknown; device?: unknown } | null;
    const email = bodyEmail(value);
    const code = bodyCode(value);
    const device = parseDeviceClaim(value?.device);
    if (email === undefined || code === undefined || typeof value?.password !== "string" || device === "invalid") {
      deny(400, "invalid_request");
      return;
    }
    const args = { email, code, password: value.password, ip: clientIp(request, ctx.trustProxy) };
    if (pathname === "/api/password/reset") {
      // Every session of the account ends, and this answer opens none: the
      // client signs in with the new password like anyone else.
      const result = await accounts.resetPasswordWithCode(args);
      if (result.status === "limited") deny(429, "rate_limited");
      else if (result.status === "refused") deny(result.reason === "email_unavailable" ? 403 : 400, result.reason);
      else send(204);
      return;
    }
    const result = await accounts.register({ ...args, ...(device === undefined ? {} : { device }) });
    if (result.status === "limited") deny(429, "rate_limited");
    else if (result.status === "refused") deny(result.reason === "registration_closed" ? 403 : 400, result.reason);
    // Lands signed in, in the same credential style login would have used.
    else signedIn(result);
    return;
  }

  if (pathname === "/api/host-link/start" || pathname === "/api/host-link/poll" || pathname === "/api/host-link/token") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    if (pathname === "/api/host-link/start") {
      const value = body.value as {
        hostId?: unknown;
        name?: unknown;
        os?: unknown;
        redirectUri?: unknown;
        codeChallenge?: unknown;
        state?: unknown;
      } | null;
      const loopback = value?.redirectUri === undefined ? undefined : parseLoopback(value);
      if (
        typeof value?.hostId !== "string" ||
        !HOST_ID_PATTERN.test(value.hostId) ||
        typeof value.name !== "string" ||
        typeof value.os !== "string" ||
        loopback === null
      ) {
        deny(400, "invalid_request");
        return;
      }
      const result = accounts.startHostLink({
        hostId: value.hostId,
        name: value.name,
        os: value.os,
        ip: clientIp(request, ctx.trustProxy),
        ...(loopback === undefined ? {} : { loopback }),
      });
      if (result.status === "limited") {
        deny(429, "rate_limited");
        return;
      }
      if (result.status === "busy") {
        deny(503, "busy");
        return;
      }
      // A loopback request's id may ride in the URL: confirming it from the
      // wrong machine sends the code to that machine's own 127.0.0.1, where
      // nobody holds the verifier.
      if (result.mode === "loopback") {
        send(200, {
          requestId: result.requestId,
          verifyUrl: `${ctx.publicOrigin}/host-link?request=${result.requestId}`,
          expiresAt: result.expiresAt,
        });
        return;
      }
      // The confirm page takes the code typed in, never from the URL: a link
      // carrying it would be one click from approving someone else's machine.
      send(200, {
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        verifyUrl: `${ctx.publicOrigin}/host-link`,
        interval: result.interval,
        expiresAt: result.expiresAt,
      });
      return;
    }
    if (pathname === "/api/host-link/token") {
      const value = body.value as { code?: unknown; codeVerifier?: unknown } | null;
      if (typeof value?.code !== "string" || value.code.length > 256 || typeof value.codeVerifier !== "string" || !PKCE_VERIFIER.test(value.codeVerifier)) {
        deny(400, "invalid_request");
        return;
      }
      const result = accounts.exchangeHostLinkCode(value.code, value.codeVerifier);
      // RFC 6749 §5.2: a spent, expired or mismatched code is invalid_grant.
      if (result.status === "invalid") deny(400, "invalid_grant");
      else send(200, { token: result.token, expiresAt: result.expiresAt });
      return;
    }
    const deviceCode = (body.value as { deviceCode?: unknown } | null)?.deviceCode;
    if (typeof deviceCode !== "string" || deviceCode.length > 256) {
      deny(400, "invalid_request");
      return;
    }
    // RFC 8628 §3.5: everything but success is a 400 with an error code.
    const result = accounts.pollHostLink(deviceCode);
    switch (result.status) {
      case "confirmed":
        send(200, { token: result.token, expiresAt: result.expiresAt });
        return;
      case "pending":
        deny(400, "authorization_pending");
        return;
      case "slow_down":
        send(400, { error: "slow_down", interval: result.interval });
        return;
      case "denied":
        deny(400, "access_denied");
        return;
      case "expired":
        deny(400, "expired_token");
        return;
    }
  }

  if (pathname === "/api/host-link/lookup" || pathname === "/api/host-link/confirm" || pathname === "/api/host-link/deny") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const token = sessionToken(request);
    if (token === undefined || accounts.authenticate(token) === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    const body = await authedJson(accounts, request, token);
    if (!body.ok) {
      deny(body.status, body.error);
      return;
    }
    const named = body.value as { userCode?: unknown; requestId?: unknown } | null;
    const ref: HostLinkRef | undefined =
      typeof named?.userCode === "string" && named.userCode.length <= 64 && named.requestId === undefined
        ? { userCode: named.userCode }
        : typeof named?.requestId === "string" && named.requestId.length <= 64 && named.userCode === undefined
          ? { requestId: named.requestId }
          : undefined;
    if (ref === undefined) {
      deny(400, "invalid_request");
      return;
    }
    const args = { userId: body.session.userId, ip: clientIp(request, ctx.trustProxy), ...ref };
    const result =
      pathname === "/api/host-link/lookup"
        ? accounts.lookupHostLink(args)
        : pathname === "/api/host-link/confirm"
          ? accounts.confirmHostLink(args)
          : accounts.denyHostLink(args);
    if (result.status === "limited") {
      deny(429, "rate_limited");
      return;
    }
    if (result.status === "not_found") {
      deny(404, "not_found");
      return;
    }
    if ("request" in result) send(200, result.request);
    else if (result.redirect !== undefined) send(200, { redirect: result.redirect });
    else send(204);
    return;
  }

  const hostRemove = /^\/api\/hosts\/([A-Za-z0-9_-]{43})\/remove$/.exec(pathname);
  if (hostRemove !== null) {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const token = sessionToken(request);
    if (token === undefined || accounts.authenticate(token) === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    const body = await authedJson(accounts, request, token);
    if (!body.ok) {
      deny(body.status, body.error);
      return;
    }
    // Confirmed again, as for kicking a device (ADR-0037 §3, ADR-0044 §6):
    // it acts on a machine other than this one, and only its terminal can
    // bring it back.
    const confirmation = bodyConfirmation(body.value, token);
    if (confirmation === undefined) {
      deny(400, "invalid_request");
      return;
    }
    const current = body.session;
    const result = await accounts.removeHost({ userId: current.userId, hostId: hostRemove[1]!, ...confirmation });
    if (result.status === "limited") {
      deny(429, "rate_limited");
      return;
    }
    if (result.status === "refused") {
      deny(result.reason === "not_found" ? 404 : 403, result.reason);
      return;
    }
    ctx.disconnectHost(hostRemove[1]!, true);
    send(204);
    return;
  }

  const hostPairing = /^\/api\/hosts\/([A-Za-z0-9_-]{43})\/pairing$/.exec(pathname);
  if (pathname === "/api/hosts" || hostPairing !== null) {
    const expected = pathname === "/api/hosts" ? "GET" : "POST";
    if (method !== expected) {
      deny(405, "method_not_allowed", { allow: expected });
      return;
    }
    const token = sessionToken(request);
    const session = token === undefined ? undefined : accounts.authenticate(token);
    if (session === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    if (pathname === "/api/hosts") {
      send(
        200,
        accounts.listHosts(session.userId).map((row) => {
          const pairing = ctx.pairing.status(row.hostId, row.noisePublicKey);
          return {
            hostId: row.hostId,
            name: row.name,
            noisePublicKey: row.noisePublicKey,
            online: pairing !== "offline",
            lastSeenAt: row.lastSeenAt,
            pairing,
            // As of its latest register: false means devices it admitted
            // can only be revoked on the host itself (ADR-0037 §5).
            deviceReports: row.deviceReports,
          };
        }),
      );
      return;
    }
    // Ownership-scoped lookup: a host bound to another account is
    // indistinguishable from one that doesn't exist.
    const row = accounts.hostFor(session.userId, hostPairing![1]!);
    if (row === undefined) {
      deny(404, "not_found");
      return;
    }
    const status = ctx.pairing.status(row.hostId, row.noisePublicKey);
    if (status !== "available") {
      deny(409, status === "offline" ? "host_offline" : status);
      return;
    }
    // A client that hangs up mid-ask drops the pending request — nobody is
    // left to spend the answer.
    const abort = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) abort.abort();
    });
    const result = await ctx.pairing.request(row.hostId, token!, abort.signal);
    // Re-verify ownership before handing out the secret: a re-join could have
    // moved the host to another account while the ask was in flight — the
    // invite must never cross an account boundary.
    if (result.status === "ok" && accounts.hostFor(session.userId, row.hostId) === undefined) {
      deny(404, "not_found");
      return;
    }
    // Remember which account device this offer goes to before it leaves, so
    // the host's report can only ever find the row (ADR-0037 §2). A session
    // that ended while the host answered — kicked, signed out — gets nothing.
    if (
      result.status === "ok" &&
      !accounts.recordVouching({ token: token!, hostId: row.hostId, requestId: result.requestId, expiresAt: result.expiresAt })
    ) {
      deny(401, "unauthenticated");
      return;
    }
    switch (result.status) {
      case "ok":
        send(200, {
          // The device dials the server's own device path; hostKey comes from
          // the stored binding — the value v2 verified equals it by now, and
          // the stored row is the one the client must pin (ADR-0022 §5).
          url: `${relayWsBase(ctx.publicOrigin)}/c/${row.hostId}`,
          hostKey: row.noisePublicKey,
          secret: result.secret,
          expiresAt: result.expiresAt,
          // Additive: old clients ignore it, and an old host simply sends none.
          // The server holds no endpoint directory; it only forwards this answer.
          ...(result.endpointSet === undefined ? {} : { endpointSet: result.endpointSet }),
        });
        return;
      case "refused":
        deny(409, result.reason);
        return;
      case "gone":
        deny(409, "host_offline");
        return;
      case "timeout":
        deny(504, "host_timeout");
        return;
      case "too_many":
        deny(429, "rate_limited");
        return;
      // "cancelled": the HTTP client is gone; nothing to answer.
    }
    return;
  }

  const deviceKick = /^\/api\/devices\/([1-9][0-9]{0,14})\/kick$/.exec(pathname);
  if (pathname === "/api/devices" || deviceKick !== null) {
    const expected = pathname === "/api/devices" ? "GET" : "POST";
    if (method !== expected) {
      deny(405, "method_not_allowed", { allow: expected });
      return;
    }
    const token = sessionToken(request);
    const session = token === undefined ? undefined : accounts.authenticate(token);
    if (session === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    if (deviceKick === null) {
      send(
        200,
        accounts.listDevices(session.userId).map((device) => ({ ...device, current: device.id === session.deviceId })),
      );
      return;
    }
    const body = await authedJson(accounts, request, token!);
    if (!body.ok) {
      deny(body.status, body.error);
      return;
    }
    // Confirmed again, as for deleting the account: a session left on a
    // lost phone must not be able to kick the owner's other devices.
    const confirmation = bodyConfirmation(body.value, token!);
    if (confirmation === undefined) {
      deny(400, "invalid_request");
      return;
    }
    // The session as of the body's end: its device is what "current" means.
    const current = body.session;
    const result = await accounts.kickDevice({
      userId: current.userId,
      deviceId: Number(deviceKick[1]),
      ...(current.deviceId === undefined ? {} : { currentDeviceId: current.deviceId }),
      ...confirmation,
    });
    if (result.status === "limited") {
      deny(429, "rate_limited");
      return;
    }
    if (result.status === "refused") {
      // 403 for the password like /api/password: 401 would read as signed out.
      deny(result.reason === "not_found" ? 404 : result.reason === "current_device" ? 409 : 403, result.reason);
      return;
    }
    for (const hostId of result.hostIds) ctx.sendRevocations(hostId);
    send(204);
    return;
  }

  if (
    pathname === "/api/me" ||
    pathname === "/api/me/email/code" ||
    pathname === "/api/me/email" ||
    pathname === "/api/logout" ||
    pathname === "/api/sessions/revoke-all" ||
    pathname === "/api/password" ||
    pathname === "/api/me/delete" ||
    pathname === "/api/join-tokens" ||
    pathname === "/api/push-tokens" ||
    pathname === "/api/push-tokens/remove"
  ) {
    const expected = pathname === "/api/me" ? "GET" : "POST";
    if (method !== expected) {
      deny(405, "method_not_allowed", { allow: expected });
      return;
    }
    const token = sessionToken(request);
    const session = token === undefined ? undefined : accounts.authenticate(token);
    if (session === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    if (pathname === "/api/me") {
      send(200, profile(session.user));
      return;
    }
    if (pathname === "/api/me/email/code" || pathname === "/api/me/email") {
      const body = await authedJson(accounts, request, token!);
      if (!body.ok) {
        deny(body.status, body.error);
        return;
      }
      // Confirmed again, as for changing the password (ADR-0044 §6): the new
      // address could reset it, so a stolen session alone must not set one.
      const confirmation = bodyConfirmation(body.value, token!);
      if (confirmation === undefined) {
        deny(400, "invalid_request");
        return;
      }
      const email = bodyEmail(body.value);
      if (email === undefined) {
        deny(400, "invalid_email");
        return;
      }
      const current = body.session;
      if (pathname === "/api/me/email/code") {
        // Signed in, so saying the email is taken tells nobody anonymous anything.
        codeSent(
          await accounts.requestEmailCode({ userId: current.userId, email, ip: clientIp(request, ctx.trustProxy), ...confirmation }),
          "email_unavailable",
        );
        return;
      }
      const code = bodyCode(body.value);
      if (code === undefined) {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.setEmail({ userId: current.userId, email, code, ...confirmation });
      if (result.status === "limited") deny(429, "rate_limited");
      else if (result.status === "refused") {
        const status = { email_taken: 409, email_unavailable: 403, wrong_password: 403, invalid_reauth: 403, invalid_code: 400 }[result.reason];
        deny(status, result.reason);
      } else send(200, profile(result.user));
      return;
    }
    if (pathname === "/api/push-tokens" || pathname === "/api/push-tokens/remove") {
      // POST bodies, never the URL: proxies log URLs, and a token is a send
      // capability within its account.
      const body = await authedJson(accounts, request, token!);
      if (!body.ok) {
        deny(body.status, body.error);
        return;
      }
      const value = body.value as { apns?: unknown; environment?: unknown } | null;
      const apns = typeof value?.apns === "string" ? normalizeApnsToken(value.apns) : undefined;
      const environment = value?.environment;
      if (apns === undefined || (environment !== "production" && environment !== "development")) {
        deny(400, "invalid_request");
        return;
      }
      const current = body.session;
      if (pathname === "/api/push-tokens") accounts.registerPushToken(current.userId, apns, environment, current.deviceId);
      else accounts.removePushToken(current.userId, apns, environment);
      send(204);
      return;
    }
    if (pathname === "/api/me/delete") {
      const body = await authedJson(accounts, request, token!);
      if (!body.ok) {
        deny(body.status, body.error);
        return;
      }
      const current = body.session;
      const confirmation = bodyConfirmation(body.value, token!);
      if (confirmation === undefined) {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.deleteAccount({ userId: current.userId, ...confirmation });
      if (result.status === "limited") {
        deny(429, "rate_limited");
        return;
      }
      if (result.status === "refused") {
        deny(403, result.reason);
        return;
      }
      // The bindings are gone, and with them the hosts' authorization: close
      // their control connections now rather than at their next register.
      for (const hostId of result.hostIds) ctx.disconnectHost(hostId);
      ctx.forgetAccount(current.userId);
      // Apple asks to be told (ADR-0044 §9); the delete never waits on it.
      for (const grant of result.appleGrants) oauth?.revokeApple(grant.refreshToken, grant.clientId);
      send(204, undefined, { "set-cookie": clearSessionCookie });
      return;
    }
    if (pathname === "/api/password") {
      const body = await authedJson(accounts, request, token!);
      if (!body.ok) {
        deny(body.status, body.error);
        return;
      }
      const current = body.session;
      const value = body.value as { currentPassword?: unknown; reauth?: unknown; newPassword?: unknown } | null;
      // The current password, or a grant (ADR-0044 §6), which also sets a
      // first password on an account that has none. Same bound as login: an
      // over-long current password can't match, and must not reach scrypt.
      const proof =
        typeof value?.currentPassword === "string" && value.reauth === undefined && [...value.currentPassword].length <= MAX_PASSWORD_CODEPOINTS
          ? { currentPassword: value.currentPassword }
          : typeof value?.reauth === "string" && value.currentPassword === undefined && value.reauth.length <= 256
            ? { reauth: value.reauth }
            : undefined;
      if (proof === undefined || typeof value?.newPassword !== "string") {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.changePassword({ userId: current.userId, keepToken: token!, newPassword: value.newPassword, ...proof });
      if (result.status === "limited") {
        deny(429, "rate_limited");
        return;
      }
      if (result.status === "refused") {
        // 403, not 401: clients treat 401 as "signed out", and a mistyped
        // current password must not sign the caller out.
        deny(result.reason === "weak_password" ? 400 : 403, result.reason);
        return;
      }
      send(204);
      return;
    }
    if (pathname === "/api/join-tokens") {
      const joinToken = accounts.createJoinToken(session.userId);
      // The command is what the "add host" UI shows: install pinomad with its
      // own Node (#499), and the script then joins this server's origin with
      // the one-time token (ADR-0022 §3). One line, for scripts.
      send(200, {
        token: joinToken.token,
        expiresAt: joinToken.expiresAt,
        command: `curl -fsSL https://pinomad.si/install.sh | sh -s -- join ${ctx.publicOrigin} ${joinToken.token}`,
      });
      return;
    }
    if (pathname === "/api/logout") {
      // Clients before #494 send no body: a plain sign-out.
      const body = await authedJson(accounts, request, token!, true);
      if (!body.ok) {
        deny(body.status, body.error);
        return;
      }
      const value = body.value;
      const revoke = typeof value === "object" && value !== null ? (value as { revoke?: unknown }).revoke : undefined;
      if (value === null || (value !== undefined && typeof value !== "object") || (revoke !== undefined && typeof revoke !== "boolean")) {
        deny(400, "invalid_request");
        return;
      }
      // With `revoke`, this device leaves every host it joined through the
      // account, as a kick would. No password: it can only withdraw the
      // caller's own device, never another.
      for (const hostId of accounts.logout(token!, { revoke: revoke === true })) ctx.sendRevocations(hostId);
      send(204, undefined, { "set-cookie": clearSessionCookie });
      return;
    }
    accounts.revokeAllSessions(session.userId);
    send(204, undefined, { "set-cookie": clearSessionCookie });
    return;
  }

  deny(404, "not_found");
}
