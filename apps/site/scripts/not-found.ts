// Post-build: turn the prerendered /404/ and /zh/404/ pages into 404.html and
// zh/404.html. Cloudflare Pages answers a path with no file using the nearest
// 404.html above it, with status 404; without one it serves index.html for
// everything.
//
// The client scripts come out: Pages serves this file at whatever URL was
// missed, and the router would hydrate against that URL instead of /404/.
// The page reads fine as plain HTML.
//
// Usage: bun scripts/not-found.ts <dist>

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: bun scripts/not-found.ts <dir>");

for (const dir of ["404", "zh/404"]) {
  const html = readFileSync(join(root, dir, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link rel="modulepreload"[^>]*>/g, "");
  writeFileSync(join(root, `${dir}.html`), html);
  rmSync(join(root, dir), { recursive: true });
}

console.log("not-found: wrote 404.html and zh/404.html");
