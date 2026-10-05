// ADR-0004: built-in features are Durable extensions, and core reaches them
// only through the registry — so nothing in src/ besides the composition root
// may import src/extensions/, and extensions may not import each other.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const extensionsDir = join(srcDir, "extensions");
const compositionRoot = join(srcDir, "main.ts");

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

function importSpecifiers(file: string): string[] {
  const content = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of content.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specifiers.push(match[1]!);
  for (const match of content.matchAll(/\bimport\s*[(]?\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  return specifiers;
}

const inExtensions = (path: string): boolean => path.startsWith(extensionsDir);

describe("extension boundary", () => {
  it("only the composition root imports built-in extensions, and extensions never import each other", () => {
    const violations: string[] = [];
    for (const file of sources(srcDir)) {
      const insideExtensions = inExtensions(file);
      for (const specifier of importSpecifiers(file)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (insideExtensions) {
          if (inExtensions(target) && target !== file) violations.push(`${file} imports sibling extension ${specifier}`);
        } else if (file !== compositionRoot && inExtensions(target)) {
          violations.push(`${file} imports extension ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
