// Post-build: write dist/sitemap.xml from the pages that were actually built.
//
// The hand-written public/sitemap.xml only knew about the two landing pages.
// This walks the prerendered index.html files (404 pages are not index.html),
// pairs /zh/ pages with their English counterparts, and emits xhtml:link
// alternates only for languages that really have the page. There is no reliable
// per-page modification time at build time, so no lastmod is written.
//
// Usage: bun scripts/sitemap.ts <dist>

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://pinomad.si";
const root = process.argv[2];
if (!root) throw new Error("usage: bun scripts/sitemap.ts <dir>");

function pagePaths(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return pagePaths(join(dir, entry.name), `${prefix}${entry.name}/`);
    return entry.name === "index.html" ? [prefix === "" ? "/" : `/${prefix}`] : [];
  });
}

const pages = pagePaths(root).sort();
if (pages.length === 0) throw new Error(`no pages under ${root}`);
const built = new Set(pages);

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function englishPath(path: string): string {
  return path.startsWith("/zh/") ? path.slice(3) : path;
}

function chinesePath(path: string): string {
  if (path.startsWith("/zh/")) return path;
  return path === "/" ? "/zh/" : `/zh${path}`;
}

const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
];

for (const path of pages) {
  const en = englishPath(path);
  const zh = chinesePath(path);
  const alternates = [
    { hreflang: "en", href: en, exists: built.has(en) },
    { hreflang: "zh-CN", href: zh, exists: built.has(zh) },
  ].filter((alternate) => alternate.exists);
  const both = alternates.length === 2;

  lines.push("  <url>", `    <loc>${escape(ORIGIN + path)}</loc>`);
  for (const alternate of alternates) {
    lines.push(
      `    <xhtml:link rel="alternate" hreflang="${alternate.hreflang}" href="${escape(ORIGIN + alternate.href)}"/>`,
    );
  }
  if (both) {
    lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escape(ORIGIN + en)}"/>`);
  }
  lines.push("  </url>");
}

lines.push("</urlset>", "");
writeFileSync(join(root, "sitemap.xml"), lines.join("\n"));
console.log(`sitemap: ${pages.length} pages`);
