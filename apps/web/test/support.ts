import { rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterAll } from "vitest";

const webConfig = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

// Vite assumes one dev server owns its deps cache: on a miss it deletes the
// cache dir, and every optimizer run renames the old one away. Test files run
// in parallel workers, so a shared apps/web/node_modules/.vite let one server
// pull the optimized deps out from under another's page load, which then got
// 504 "Outdated Optimize Dep" and never mounted. Servers within one file run
// one after another, so a cache per worker process is enough.
const cacheDir = fileURLToPath(new URL(`../node_modules/.vite-test/${process.pid}`, import.meta.url));
afterAll(() => rm(cacheDir, { recursive: true, force: true }));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function serve(options?: { readonly port?: number; readonly apiTarget?: string }) {
  const vite = await createServer({
    configFile: webConfig,
    cacheDir,
    server: {
      port: options?.port ?? (await freePort()),
      ...(options?.apiTarget === undefined ? {} : { proxy: { "/api": { target: options.apiTarget } } }),
    },
    logLevel: "error",
  });
  await vite.listen();
  return { origin: new URL(vite.resolvedUrls!.local[0]!).origin, close: () => vite.close() };
}

// A closed dev server does not give all of its memory back, so a fresh server
// per test grew web-ui.test.ts's worker past the heap limit. Tests without a
// pinned port or proxy share one per worker; each test's browser context
// already keeps its storage apart.
let shared: Promise<{ origin: string; close: () => Promise<void> }> | undefined;
afterAll(async () => {
  await (await shared)?.close();
  shared = undefined;
});

/**
 * Serve apps/web from a Vite dev server; returns its origin. Without options
 * the worker's shared server answers. `apiTarget` proxies `/api` to an
 * account server, so the page is that server's own origin (cookie mode,
 * ADR-0022 §2); `port` pins the origin the server was started with. Those get
 * a server of their own, closed with the test.
 */
export async function startWeb(
  defer: (cleanup: () => Promise<void> | void) => void,
  options?: { readonly port?: number; readonly apiTarget?: string },
): Promise<string> {
  if (options === undefined) {
    shared ??= serve();
    return (await shared).origin;
  }
  const server = await serve(options);
  defer(server.close);
  return server.origin;
}
