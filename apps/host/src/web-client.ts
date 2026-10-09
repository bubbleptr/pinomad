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

/** The listener's HTTP side: the built web client, nothing else. */
export async function serveWebClient(request: IncomingMessage, response: ServerResponse, webRoot: string | undefined): Promise<void> {
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
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
}
