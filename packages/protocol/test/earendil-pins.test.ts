// Every @earendil-works/* dependency in the repo is pinned to an exact version
// (no ^, ~, *, latest, workspace: or other ranges). It sits in the protocol
// project, whose CI job runs on any root package.json or bun.lock change. A PR
// that edits only an app's package.json runs that app's job, not this one:
// bun's --frozen-lockfile accepts a ^ specifier without a bun.lock change.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./runtime-boundaries.ts";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
] as const;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

it("pins every @earendil-works/* dependency to an exact version", () => {
  const manifests = execFileSync("git", ["ls-files", "-z", "--", "package.json", "**/package.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  expect(manifests).toContain("packages/protocol/package.json");

  const loose: string[] = [];
  for (const manifest of manifests) {
    const json = JSON.parse(readFileSync(join(REPO_ROOT, manifest), "utf8")) as Record<string, unknown>;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries((json[field] ?? {}) as Record<string, unknown>)) {
        if (name.startsWith("@earendil-works/") && !(typeof spec === "string" && EXACT.test(spec))) {
          loose.push(`${manifest}  ${field}.${name}  ${JSON.stringify(spec)}`);
        }
      }
    }
  }
  expect(loose).toEqual([]);
});
