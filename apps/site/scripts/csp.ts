// Post-build: give every prerendered page a <meta> CSP that allows exactly its
// own inline scripts, by hash.
//
// The framework writes inline scripts (router state for hydration, the docs
// theme switch) whose content changes on every build, so no single header can
// list their hashes. public/_headers therefore allows 'unsafe-inline' for
// script-src and style-src, and this meta policy narrows it: the browser
// enforces both policies, so an inline script runs only if its hash is here.
// A page without the meta would be left with 'unsafe-inline' alone, so the
// build fails if one can't be placed.
//
// Usage: node scripts/csp.ts <dist/client>

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/csp.ts <dir>");

const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

const files = htmlFiles(root);
if (files.length === 0) throw new Error(`no HTML under ${root}`);

let relaxed = 0;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  if (html.includes('http-equiv="Content-Security-Policy"')) throw new Error(`${file} already has a CSP meta`);

  const scripts = new Set<string>();
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(attrs) || body === "") continue;
    scripts.add(hash(body));
  }
  // Docs and blog pages carry style="" attributes (Shiki's code colours, Base UI
  // layout), which no hash can allow short of 'unsafe-hashes' per value. Those
  // pages keep inline styles; the landing page has none and stays on hashes.
  let styleSrc: string;
  if (/\sstyle="/.test(html)) {
    styleSrc = "style-src 'self' 'unsafe-inline'";
    relaxed += 1;
  } else {
    const styles = new Set<string>();
    for (const [, body] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) styles.add(hash(body));
    styleSrc = `style-src 'self' ${[...styles].join(" ")}`.trim();
  }

  const policy = `${`script-src 'self' ${[...scripts].join(" ")}`.trim()}; ${styleSrc}`;
  const head = html.indexOf("<head>");
  if (head === -1) throw new Error(`${file} has no <head>`);
  // First thing in <head>: a meta policy only governs what comes after it.
  const at = head + "<head>".length;
  writeFileSync(file, `${html.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${policy}"/>${html.slice(at)}`);
}

console.log(`csp: ${files.length} pages, ${relaxed} with inline styles allowed`);
