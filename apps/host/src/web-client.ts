// Serving the built web client over plain HTTP. Shared by the gateway's
// listeners and the relay: both can be the thing a phone loads the client
// from (ADR-0008; the relay serves its own checkout's dist, version skew
// accepted — the client's `outdated` state plus one reload covers it).

import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const WEB_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

const NOT_BUILT = "Web client not built: run bun run build";

// The page holds login sessions and device keys, so nothing outside the
// bundle may run in it. Directives beyond default-src, each for a need:
// - script-src 'wasm-unsafe-eval': the diff highlighter compiles its
//   WebAssembly regex engine; it allows WebAssembly compilation, not eval().
// - script-src blob:: plugin UI (ADR-0049) is fetched over the host
//   connection, hash-checked, and imported from a blob: URL the page made.
// - style-src 'unsafe-inline': the diff highlighter injects <style> elements
//   into its shadow roots at runtime, so neither a hash nor a nonce can cover them.
// - img-src data:: message images and placeholders are data: URLs.
// - connect-src ws: wss:: a host's remote candidates can be any socket URL
//   (endpoints.ts); account fetches stay same-origin (bearer mode is desktop-only).
// - object-src, base-uri, form-action: not covered by default-src.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * The page plugins render model-written HTML in (ADR-0049): it is framed with
 * `sandbox="allow-scripts"`, receives the HTML by postMessage and writes it
 * into itself. Its scripts must run, so the page cannot share the client's
 * policy; instead it gets no network at all, keeps an opaque origin even when
 * opened directly (`sandbox`), and only the client's own origin may frame it.
 */
export const SANDBOX_PAGE = "sandbox.html";
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

/** The listener's HTTP side: the built web client, nothing else. */
export async function serveWebClient(request: IncomingMessage, response: ServerResponse, webRoot: string | undefined): Promise<void> {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (webRoot === undefined) {
    response.writeHead(503, { "content-type": "text/plain" }).end(NOT_BUILT);
    return;
  }
  const root = resolve(webRoot);
  const index = join(root, "index.html");
  if (!(await stat(index).catch(() => undefined))?.isFile()) {
    response.writeHead(503, { "content-type": "text/plain" }).end(NOT_BUILT);
    return;
  }
  // Reject traversal on the raw target — URL parsing already normalizes ".."
  // away, so the check has to run on the undecoded segments.
  let decoded: string;
  try {
    decoded = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (decoded.split("/").includes("..")) {
    response.writeHead(404).end();
    return;
  }
  const inside = resolve(join(root, decoded));
  if (!inside.startsWith(root + sep) && inside !== root) {
    response.writeHead(404).end();
    return;
  }
  // Extensionless routes are the SPA's own paths → index.html.
  const file = extname(inside) === "" ? index : inside;
  const body = await readFile(file).catch(() => undefined);
  if (body === undefined) {
    response.writeHead(404).end();
    return;
  }
  // index.html must not be cached: after an upgrade a reload has to fetch the
  // bundle matching the new protocol. Hashed assets keep the default.
  const headers: Record<string, string> = { "content-type": WEB_TYPES[extname(file)] ?? "application/octet-stream" };
  if (file === index) headers["cache-control"] = "no-cache";
  if (file === join(root, SANDBOX_PAGE)) headers["content-security-policy"] = SANDBOX_CSP;
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
}
