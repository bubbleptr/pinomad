// npm's side of an upgrade, shared by `pinomad upgrade` and the host itself
// (ADR-0043 §3, §8): which npm to run, where the package lives, what the
// latest release is, and installing one exact version.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalPrefixOf, packageDir } from "../distribution.ts";
import type { Release } from "./upgrader.ts";

/** A command to run, `binDir` first on its PATH. */
export interface NpmCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly binDir?: string;
}

/**
 * The npm that ships with the node running pinomad, which is the node the
 * service runs too. An install-script runtime (#499) has no other npm, and a
 * different one on PATH could pick native prebuilds for another node. Falls
 * back to `npm` on PATH when there is none beside it.
 */
export function npmBeside(execPath: string): NpmCommand {
  const binDir = dirname(execPath);
  const cli = join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? { command: execPath, args: [cli], binDir } : { command: "npm", args: [] };
}

/**
 * The global prefix owning this package, or undefined when it isn't a global
 * npm install. An unqualified `npm install -g` would target the caller's
 * current prefix, and the service would keep running the old version.
 */
export const packagePrefix = (): string | undefined => globalPrefixOf(packageDir);

/** `npm install -g` of `spec` (`pinomad@latest` or `pinomad@<version>`) into `prefix`. */
export function installCommand(npm: NpmCommand, prefix: string, spec: string): NpmCommand {
  return { ...npm, args: [...npm.args, "install", "-g", "--prefix", prefix, spec] };
}

/** `npm view` of the latest release: its version, publish times and the `pinomad` package.json field. */
export function viewCommand(npm: NpmCommand): NpmCommand {
  return { ...npm, args: [...npm.args, "view", "pinomad@latest", "version", "time", "pinomad", "--json"] };
}

/**
 * Parses `npm view pinomad@latest version time pinomad --json`. npm reads its
 * own registry and proxy configuration, so the host needs none of its own.
 */
export function parseRelease(stdout: string): Release {
  const value = JSON.parse(stdout) as { version?: unknown; time?: unknown; pinomad?: unknown };
  if (typeof value.version !== "string") throw new Error("npm view returned no version");
  const time = value.time as Record<string, unknown> | undefined;
  const published = typeof time?.[value.version] === "string" ? Date.parse(time[value.version] as string) : Number.NaN;
  if (Number.isNaN(published)) throw new Error(`npm view returned no publish time for ${value.version}`);
  const field = value.pinomad as { protocolMajor?: unknown } | undefined;
  const major = field?.protocolMajor;
  return {
    version: value.version,
    publishedAt: published,
    ...(typeof major === "number" && Number.isSafeInteger(major) ? { protocolMajor: major } : {}),
  };
}

/** The last `lines` non-empty lines of npm's output, for a failed install's message. */
export function outputTail(output: string, lines = 12): string {
  return output.split("\n").filter((line) => line.trim() !== "").slice(-lines).join("\n");
}
