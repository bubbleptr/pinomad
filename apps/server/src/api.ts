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
import {
  MAX_PASSWORD_CODEPOINTS,
  MAX_USERNAME_CODEPOINTS,
  normalizeApnsToken,
  normalizeEmail,
  parseDeviceClaim,
  type AccountUser,
  type Accounts,
  type HostLinkLoopback,
  type HostLinkRef,
  type SendCodeResult,
} from "./accounts.ts";

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

/** Bearer token first, then the browser session cookie. */
function sessionToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const cookieAttributes = "Path=/; Secure; HttpOnly; SameSite=Strict";
const setSessionCookie = (token: string): string => `${SESSION_COOKIE}=${token}; ${cookieAttributes}`;
const clearSessionCookie = `${SESSION_COOKIE}=; ${cookieAttributes}; Max-Age=0`;

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
  const loginTokenMode = ANONYMOUS_ACCOUNT_ROUTES.has(pathname) && (origin === undefined || origin === DESKTOP_ORIGIN);
  // The host CLI starts and polls a host link with no credential at all, so
  // there is nothing to forge; it sends no Origin, and only that is let past.
  const hostLinkHostMode =
    (pathname === "/api/host-link/start" || pathname === "/api/host-link/poll" || pathname === "/api/host-link/token") &&
    origin === undefined;
  if (MUTATING.has(method) && !bearer && !loginTokenMode && !hostLinkHostMode && origin !== ctx.publicOrigin) {
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
    // Providers arrive with #620.
    send(200, { registration: accounts.registrationOpen, email: accounts.emailEnabled, providers: [] });
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
    // The password again, as for kicking a device (ADR-0037 §3): it acts on
    // a machine other than this one, and only its terminal can bring it back.
    const value = body.value as { password?: unknown } | null;
    if (typeof value?.password !== "string" || [...value.password].length > MAX_PASSWORD_CODEPOINTS) {
      deny(400, "invalid_request");
      return;
    }
    const current = body.session;
    const result = await accounts.removeHost({
      userId: current.userId,
      password: value.password,
      hostId: hostRemove[1]!,
    });
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
    // The password again, as for deleting the account: a session left on a
    // lost phone must not be able to kick the owner's other devices.
    const value = body.value as { password?: unknown } | null;
    if (typeof value?.password !== "string" || [...value.password].length > MAX_PASSWORD_CODEPOINTS) {
      deny(400, "invalid_request");
      return;
    }
    // The session as of the body's end: its device is what "current" means.
    const current = body.session;
    const result = await accounts.kickDevice({
      userId: current.userId,
      password: value.password,
      deviceId: Number(deviceKick[1]),
      ...(current.deviceId === undefined ? {} : { currentDeviceId: current.deviceId }),
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
      const email = bodyEmail(body.value);
      if (email === undefined) {
        deny(400, "invalid_email");
        return;
      }
      const current = body.session;
      if (pathname === "/api/me/email/code") {
        // Signed in, so saying the email is taken tells nobody anonymous anything.
        codeSent(accounts.requestEmailCode({ userId: current.userId, email, ip: clientIp(request, ctx.trustProxy) }), "email_unavailable");
        return;
      }
      const code = bodyCode(body.value);
      if (code === undefined) {
        deny(400, "invalid_request");
        return;
      }
      const result = accounts.setEmail({ userId: current.userId, email, code });
      if (result.status === "limited") deny(429, "rate_limited");
      else if (result.status === "refused") {
        deny(result.reason === "email_taken" ? 409 : result.reason === "email_unavailable" ? 403 : 400, result.reason);
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
      const value = body.value as { password?: unknown } | null;
      if (typeof value?.password !== "string" || [...value.password].length > MAX_PASSWORD_CODEPOINTS) {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.deleteAccount({ userId: current.userId, password: value.password });
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
      const value = body.value as { currentPassword?: unknown; newPassword?: unknown } | null;
      // Same bound as login: an over-long current password can't match, and
      // must not reach scrypt.
      if (
        typeof value?.currentPassword !== "string" ||
        typeof value.newPassword !== "string" ||
        [...value.currentPassword].length > MAX_PASSWORD_CODEPOINTS
      ) {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.changePassword({
        userId: current.userId,
        keepToken: token!,
        currentPassword: value.currentPassword,
        newPassword: value.newPassword,
      });
      if (result.status === "limited") {
        deny(429, "rate_limited");
        return;
      }
      if (result.status === "refused") {
        // 403, not 401: clients treat 401 as "signed out", and a mistyped
        // current password must not sign the caller out.
        deny(result.reason === "wrong_password" ? 403 : 400, result.reason);
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
