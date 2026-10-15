// The server's HTTP account API (ADR-0022 §2), mounted on the same port as the
// splice sockets and the static web client: POST /api/login, POST /api/logout,
// POST /api/sessions/revoke-all, GET /api/me.
//
// Two credential styles share the routes: browsers on the web client get a
// Secure+HttpOnly+SameSite=Strict host-only cookie (so mutating requests must
// pass an Origin check), desktop and mobile send `Authorization: Bearer`.
// No CORS headers are emitted — nothing cross-origin is meant to call this.

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

const fail = (response: ServerResponse, status: number, error: string, headers?: Record<string, string>): void =>
  respond(response, status, { error }, headers);

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

  if (!secureTransport(request, ctx.trustProxy)) {
    fail(response, 403, "https_required");
    return;
  }
  // Cookies are ambient credentials, so every mutating request must carry the
  // server's own Origin — browsers always send it on cross-site POSTs.
  const origin = request.headers.origin;
  if (MUTATING.has(request.method ?? "") && origin !== undefined && origin !== ctx.publicOrigin) {
    fail(response, 403, "origin_mismatch");
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://server.invalid").pathname;
  } catch {
    pathname = "";
  }
  const method = request.method ?? "";

  if (pathname === "/api/login") {
    if (method !== "POST") {
      fail(response, 405, "method_not_allowed", { allow: "POST" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      fail(response, body.tooLarge ? 413 : 400, body.tooLarge ? "payload_too_large" : "invalid_json");
      return;
    }
    const value = body.value;
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { username?: unknown }).username !== "string" ||
      typeof (value as { password?: unknown }).password !== "string"
    ) {
      fail(response, 400, "invalid_request");
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
      fail(response, 400, "invalid_request");
      return;
    }
    const result = await accounts.login(username, password, clientIp(request, ctx.trustProxy));
    if (result.status === "limited") {
      fail(response, 429, "rate_limited");
      return;
    }
    if (result.status === "invalid") {
      fail(response, 401, "invalid_credentials");
      return;
    }
    respond(
      response,
      200,
      { user: { username }, token: result.token, expiresAt: result.expiresAt },
      { "set-cookie": setSessionCookie(result.token) },
    );
    return;
  }

  if (pathname === "/api/me" || pathname === "/api/logout" || pathname === "/api/sessions/revoke-all") {
    const expected = pathname === "/api/me" ? "GET" : "POST";
    if (method !== expected) {
      fail(response, 405, "method_not_allowed", { allow: expected });
      return;
    }
    const token = sessionToken(request);
    const session = token === undefined ? undefined : accounts.authenticate(token);
    if (session === undefined) {
      fail(response, 401, "unauthenticated");
      return;
    }
    if (pathname === "/api/me") {
      respond(response, 200, { user: { username: session.username } });
      return;
    }
    if (pathname === "/api/logout") {
      accounts.logout(token!);
      respond(response, 204, undefined, { "set-cookie": clearSessionCookie });
      return;
    }
    accounts.revokeAllSessions(session.userId);
    respond(response, 204, undefined, { "set-cookie": clearSessionCookie });
    return;
  }

  fail(response, 404, "not_found");
}
