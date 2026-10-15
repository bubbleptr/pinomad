// The server's HTTP account API (ADR-0022 §2), mounted on the same port as the
// splice sockets and the static web client: POST /api/login, POST /api/logout,
// POST /api/sessions/revoke-all, GET /api/me.
//
// Two credential styles share the routes, decided by the request's Origin:
// the same-origin web client gets a Secure+HttpOnly+SameSite=Strict host-only
// cookie (mutating requests then must carry that Origin), while the desktop
// app (app://pinomad) and Origin-less native clients get the bare token for
// `Authorization: Bearer`. Bearer requests have no ambient credential, so the
// Origin check doesn't apply to them; CORS is emitted only for the desktop
// origin, and never with credentials.

import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_PASSWORD_CODEPOINTS, MAX_USERNAME_CODEPOINTS, type Accounts } from "./accounts.ts";

export interface ApiContext {
  readonly accounts: Accounts;
  /** The origin browsers open the server under; Origin headers must match it. */
  readonly publicOrigin: string;
  /** Only set behind a TLS-terminating proxy — enables trusting X-Forwarded-*. */
  readonly trustProxy: boolean;
}

const SESSION_COOKIE = "__Host-pinomad-session";
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

function respond(response: ServerResponse, status: number, body?: Record<string, unknown>, headers?: Record<string, string>): void {
  const all: Record<string, string> = { ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  response.writeHead(status, all);
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

/** Reads the request body fully; "too-large" drains the rest so the 413 still reaches the client. */
async function readJson(request: IncomingMessage): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly tooLarge: boolean }> {
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
  const send = (status: number, body?: Record<string, unknown>, headers?: Record<string, string>): void =>
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
  // same-origin — except login, which also answers desktop and Origin-less
  // native callers in token mode (its own branch picks the response style).
  const bearer = (request.headers.authorization ?? "").startsWith("Bearer ");
  const loginTokenMode = pathname === "/api/login" && (origin === undefined || origin === DESKTOP_ORIGIN);
  if (MUTATING.has(method) && !bearer && !loginTokenMode && origin !== ctx.publicOrigin) {
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
    // Same bounds the account layer enforces at creation (accounts.ts) — a
    // field outside them can never match a stored credential.
    if (
      [...username].length === 0 ||
      [...username].length > MAX_USERNAME_CODEPOINTS ||
      [...password].length > MAX_PASSWORD_CODEPOINTS
    ) {
      deny(400, "invalid_request");
      return;
    }
    const result = await accounts.login(username, password, clientIp(request, ctx.trustProxy));
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
      { user: { username }, expiresAt: result.expiresAt, ...(cookieMode ? {} : { token: result.token }) },
      cookieMode ? { "set-cookie": setSessionCookie(result.token) } : undefined,
    );
    return;
  }

  if (pathname === "/api/me" || pathname === "/api/logout" || pathname === "/api/sessions/revoke-all") {
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
      send(200, { user: { username: session.username } });
      return;
    }
    if (pathname === "/api/logout") {
      accounts.logout(token!);
      send(204, undefined, { "set-cookie": clearSessionCookie });
      return;
    }
    accounts.revokeAllSessions(session.userId);
    send(204, undefined, { "set-cookie": clearSessionCookie });
    return;
  }

  deny(404, "not_found");
}
