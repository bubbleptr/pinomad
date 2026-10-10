import { extname, isAbsolute, relative, resolve } from "node:path";

/**
 * What the bundled renderer is allowed to reach: its own bundle, WebSocket
 * connections to a host or relay, and inline styles (Astryx sets style props).
 * Nothing else: no remote scripts, no remote fonts, no http fetches.
 */
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ws: wss:";

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
    if (url.protocol !== "app:") return undefined;
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
