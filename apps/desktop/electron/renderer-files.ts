import { extname, isAbsolute, relative, resolve } from "node:path";

/**
 * What the bundled renderer is allowed to reach: its own bundle, WebSocket
 * connections to a host or relay, and inline styles (the diff highlighter
 * injects <style> elements).
 * Nothing else: no remote scripts, no remote fonts. connect-src also takes
 * `https:` for the server-accounts API (ADR-0022) — `wss:` already lets the
 * page dial any host, so allowing https fetches opens no new reach while
 * plain http stays out. script-src takes 'wasm-unsafe-eval' for the diff
 * highlighter's WebAssembly regex engine; it allows no eval(). It takes
 * `blob:` for plugin UI (ADR-0049): bundles arrive over the host connection,
 * are hash-checked, and are imported from a blob: URL the page made.
 */
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ws: wss: https:";

/**
 * The page plugins render model-written HTML in (ADR-0049), the same policy
 * as apps/host/src/web-client.ts sends: its scripts run in an opaque origin,
 * framed only by the app itself; fetches are blocked as best effort.
 */
const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'; sandbox allow-scripts";

/** The policy a bundled file is served with: the sandbox page's own, every other file the renderer's. */
export function cspFor(file: string, rendererDir: string): string {
  return file === resolve(rendererDir, "sandbox.html") ? SANDBOX_CSP : RENDERER_CSP;
}

export const APP_SCHEME = "app";
export const APP_HOST = "pinomad";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * app://pinomad/<path> → a file inside `rendererDir`. The URL parser already
 * collapses literal `..`; encoded traversal survives to here and is refused —
 * the only code a sandboxed renderer can force this handler to run is the path
 * lookup itself.
 */
export function rendererFilePath(rendererDir: string, rawUrl: string): string | undefined {
  let pathname: string;
  try {
    const url = new URL(rawUrl);
    // Only the app's own origin may read the bundle — any other app:// host
    // (or a typo'd authority) is a 404, same as a missing file.
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined;
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  // "//host/path" would be parsed as a URL with an empty path by another
  // scheme's rules; here it is an attempted absolute path — refuse it.
  if (pathname.startsWith("//")) return undefined;
  // A decoded `..` segment can only come from %-encoding; reject before resolve.
  if (pathname.split("/").includes("..")) return undefined;
  const resolved = resolve(rendererDir, `.${pathname}`);
  const inside = relative(rendererDir, resolved);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return resolved;
}

/** Response content type for a bundled file; unknown extensions stay opaque. */
export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
