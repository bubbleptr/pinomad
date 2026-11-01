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

/** Serve apps/web from a Vite dev server for one test; returns its origin. */
export async function startWeb(defer: (cleanup: () => Promise<void> | void) => void): Promise<string> {
  const vite = await createServer({ configFile: webConfig, cacheDir, server: { port: await freePort() }, logLevel: "error" });
  await vite.listen();
  defer(() => vite.close());
  return new URL(vite.resolvedUrls!.local[0]!).origin;
}
