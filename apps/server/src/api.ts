// The server's HTTP account API (ADR-0022 §2), mounted on the same port as the
// splice sockets and the static web client: POST /api/login, POST /api/register,
// POST /api/logout (`{ revoke: true }` also takes this device off its hosts, #494),
// POST /api/sessions/revoke-all, GET /api/me, POST /api/password (#450),
// POST /api/me/delete (#451), GET /api/devices and POST /api/devices/:id/kick
// (ADR-0037),
// POST /api/join-tokens, POST /api/push-tokens and POST /api/push-tokens/remove
// (ADR-0036), and for the admin GET/POST /api/invites and
// POST /api/invites/revoke (#449). Host links (#495, RFC 8628) put a device
// code in front of the join token: the host CLI calls POST /api/host-link/start
// and /poll with no credential, a signed-in user POST /api/host-link/lookup,
// /confirm and /deny.
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
  parseDeviceClaim,
  type Accounts,
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
  /** Closes a host's control connection once its account binding is gone. */
  readonly disconnectHost: (hostId: string) => void;
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
const MAX_BODY = 8 * 1024;
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
  // same-origin — except login and register, which also answer desktop and
  // Origin-less native callers in token mode (their branch picks the response
  // style).
  const bearer = (request.headers.authorization ?? "").startsWith("Bearer ");
  const loginTokenMode =
    (pathname === "/api/login" || pathname === "/api/register") && (origin === undefined || origin === DESKTOP_ORIGIN);
  // The host CLI starts and polls a host link with no credential at all, so
  // there is nothing to forge; it sends no Origin, and only that is let past.
  const hostLinkHostMode = (pathname === "/api/host-link/start" || pathname === "/api/host-link/poll") && origin === undefined;
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
    // Same-origin browser sessions ride the HttpOnly cookie — the token never
    // enters a body the page's JS could read. Desktop/native callers get the
    // bare token for secure storage and no cookie.
    const cookieMode = origin === ctx.publicOrigin;
    send(
      200,
      {
        user: { username },
        ...(result.admin ? { admin: true } : {}),
        expiresAt: result.expiresAt,
        ...(cookieMode ? {} : { token: result.token }),
      },
      cookieMode ? { "set-cookie": setSessionCookie(result.token) } : undefined,
    );
    return;
  }

  if (pathname === "/api/register") {
    if (method !== "POST") {
      deny(405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const value = body.value as { invite?: unknown; username?: unknown; password?: unknown; device?: unknown } | null;
    const device = parseDeviceClaim(value?.device);
    if (
      typeof value?.invite !== "string" ||
      typeof value.username !== "string" ||
      typeof value.password !== "string" ||
      device === "invalid"
    ) {
      deny(400, "invalid_request");
      return;
    }
    const { invite, username } = value as { invite: string; username: string; password: string };
    const result = await accounts.register({
      invite,
      username,
      password: value.password,
      ip: clientIp(request, ctx.trustProxy),
      ...(device === undefined ? {} : { device }),
    });
    if (result.status === "limited") {
      deny(429, "rate_limited");
      return;
    }
    if (result.status === "refused") {
      const status =
        result.reason === "invalid_invite" || result.reason === "invite_expired"
          ? 403
          : result.reason === "username_taken"
            ? 409
            : 400;
      deny(status, result.reason);
      return;
    }
    // Lands signed in, in the same credential style login would have used.
    const cookieMode = origin === ctx.publicOrigin;
    send(
      200,
      { user: { username }, expiresAt: result.expiresAt, ...(cookieMode ? {} : { token: result.token }) },
      cookieMode ? { "set-cookie": setSessionCookie(result.token) } : undefined,
    );
    return;
  }

  if (pathname === "/api/host-link/start" || pathname === "/api/host-link/poll") {
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
      const value = body.value as { hostId?: unknown; name?: unknown; os?: unknown } | null;
      if (
        typeof value?.hostId !== "string" ||
        !HOST_ID_PATTERN.test(value.hostId) ||
        typeof value.name !== "string" ||
        typeof value.os !== "string"
      ) {
        deny(400, "invalid_request");
        return;
      }
      const result = accounts.startHostLink({
        hostId: value.hostId,
        name: value.name,
        os: value.os,
        ip: clientIp(request, ctx.trustProxy),
      });
      if (result.status === "limited") {
        deny(429, "rate_limited");
        return;
      }
      if (result.status === "busy") {
        deny(503, "busy");
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
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const userCode = (body.value as { userCode?: unknown } | null)?.userCode;
    if (typeof userCode !== "string" || userCode.length > 64) {
      deny(400, "invalid_request");
      return;
    }
    // Re-read: the session may have ended while the body trickled in, and a
    // confirm must land on an account that is still signed in.
    const session = accounts.authenticate(token);
    if (session === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    const args = { userId: session.userId, userCode, ip: clientIp(request, ctx.trustProxy) };
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
    else send(204);
    return;
  }

  if (pathname === "/api/invites" || pathname === "/api/invites/revoke") {
    const allowed = pathname === "/api/invites" ? ["GET", "POST"] : ["POST"];
    if (!allowed.includes(method)) {
      deny(405, "method_not_allowed", { allow: allowed.join(", ") });
      return;
    }
    const token = sessionToken(request);
    const session = token === undefined ? undefined : accounts.authenticate(token);
    if (session === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    if (!session.admin) {
      deny(403, "forbidden");
      return;
    }
    if (pathname === "/api/invites") {
      if (method === "GET") send(200, accounts.listInvites());
      else send(200, accounts.createInvite(session.userId));
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const id = (body.value as { id?: unknown } | null)?.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      deny(400, "invalid_request");
      return;
    }
    // The session may have been revoked while the body trickled in, as on
    // the push-token routes.
    if (accounts.authenticate(token!)?.admin !== true) {
      deny(401, "unauthenticated");
      return;
    }
    if (accounts.revokeInvite(id)) send(204);
    else deny(404, "not_found");
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
    const body = await readJson(request);
    if (!body.ok) {
      deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    // The password again, as for deleting the account: a session left on a
    // lost phone must not be able to kick the owner's other devices.
    const value = body.value as { password?: unknown } | null;
    if (typeof value?.password !== "string" || [...value.password].length > MAX_PASSWORD_CODEPOINTS) {
      deny(400, "invalid_request");
      return;
    }
    // Re-read: the session may have been kicked or signed out while the body
    // trickled in, and its device is what "current" means.
    const current = accounts.authenticate(token!);
    if (current === undefined) {
      deny(401, "unauthenticated");
      return;
    }
    const result = await accounts.kickDevice({
      userId: current.userId,
      username: current.username,
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
      // `admin` only appears when true, so regular accounts see the old shape.
      send(200, { user: { username: session.username }, ...(session.admin ? { admin: true } : {}) });
      return;
    }
    if (pathname === "/api/push-tokens" || pathname === "/api/push-tokens/remove") {
      // POST bodies, never the URL: proxies log URLs, and a token is a send
      // capability within its account.
      const body = await readJson(request);
      if (!body.ok) {
        deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
        return;
      }
      const value = body.value as { apns?: unknown; environment?: unknown } | null;
      const apns = typeof value?.apns === "string" ? normalizeApnsToken(value.apns) : undefined;
      const environment = value?.environment;
      if (apns === undefined || (environment !== "production" && environment !== "development")) {
        deny(400, "invalid_request");
        return;
      }
      // The session may have been revoked while the body trickled in; a
      // registration written now would outlive "sign out everywhere".
      const current = accounts.authenticate(token!);
      if (current === undefined) {
        deny(401, "unauthenticated");
        return;
      }
      if (pathname === "/api/push-tokens") accounts.registerPushToken(session.userId, apns, environment, current.deviceId);
      else accounts.removePushToken(session.userId, apns, environment);
      send(204);
      return;
    }
    if (pathname === "/api/me/delete") {
      const body = await readJson(request);
      if (!body.ok) {
        deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
        return;
      }
      const value = body.value as { password?: unknown } | null;
      if (typeof value?.password !== "string" || [...value.password].length > MAX_PASSWORD_CODEPOINTS) {
        deny(400, "invalid_request");
        return;
      }
      const result = await accounts.deleteAccount({ userId: session.userId, username: session.username, password: value.password });
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
      ctx.forgetAccount(session.userId);
      send(204, undefined, { "set-cookie": clearSessionCookie });
      return;
    }
    if (pathname === "/api/password") {
      const body = await readJson(request);
      if (!body.ok) {
        deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
        return;
      }
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
        userId: session.userId,
        username: session.username,
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
      const body = await readJson(request, true);
      if (!body.ok) {
        deny(body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
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
