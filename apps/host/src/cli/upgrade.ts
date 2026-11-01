#!/usr/bin/env node
// `pinomad upgrade` / `bun run upgrade` [--force] [--data-dir D] [--url U] —
// update and restart the service (ADR-0009 §6, amended by ADR-0016). Packaged
// installs pull `pinomad@latest` from npm; a source checkout pulls git +
// reinstalls deps + rebuilds. Any failed step stops before the restart, so
// the service keeps running the old code.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { commandHint, globalPrefixOf, packageDir, packagedVersion } from "../distribution.ts";
import { serviceManager } from "../service/manager.ts";
import { isParseArgsError, reportParseArgsError } from "./args.ts";
import { hostAddressOptions } from "./host-address.ts";
import { restartService } from "./service.ts";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const step = (command: string, args: readonly string[], binDir?: string): Promise<number> =>
  new Promise((resolve) => {
    const env = binDir === undefined ? process.env : { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    spawn(command, [...args], { cwd: repoRoot, env, stdio: "inherit" }).once("exit", (code) => resolve(code ?? 1));
  });

/**
 * The npm that ships with the node running pinomad, which is the node the
 * service runs too. An install-script runtime (#499) has no other npm, and a
 * different one on PATH could pick native prebuilds for another node. Falls
 * back to `npm` on PATH when there is none beside it.
 */
export function npmBeside(execPath: string): { command: string; args: readonly string[]; binDir?: string } {
  const binDir = dirname(execPath);
  const cli = join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? { command: execPath, args: [cli], binDir } : { command: "npm", args: [] };
}

// A source checkout / global install without the service still upgrades
// fine — just no restart; unsupported platforms (serviceManager throws)
// land here too.
const serviceInstalled = (): Promise<boolean> =>
  Promise.resolve()
    .then(() => serviceManager().state())
    .then((state) => state.installed, () => false);

export interface UpgradeDeps {
  /** One-shot exec for the `git status` check; defaults to execFile in the repo root. */
  readonly run?: (command: string, args: readonly string[]) => Promise<{ stdout: string }>;
  /** A foreground step (npm/git/bun, stdio inherit), `binDir` first on its PATH; injected so tests never run them. */
  readonly step?: (command: string, args: readonly string[], binDir?: string) => Promise<number>;
  /** Whether the user service is installed; defaults to asking the platform manager. */
  readonly serviceInstalled?: () => Promise<boolean>;
  /** The post-install restart; defaults to `restartService`. */
  readonly restart?: (options: { force: boolean; argv: readonly string[] }) => Promise<number>;
  /** The exit after a restart ran; defaults to `process.exit`, injected by tests. */
  readonly exit?: (code: number) => void;
}

export async function main(argv: readonly string[], deps: UpgradeDeps = {}): Promise<void> {
  // Parse everything upgrade forwards — its own --force plus the host-address
  // flags restartService consumes — before touching npm/git: a typo must not
  // run the install first and only fail at the restart (issue #164).
  const { values } = parseArgs({
    args: [...argv],
    options: { force: { type: "boolean", default: false }, ...hostAddressOptions },
  });
  const run = deps.run ?? ((command: string, args: readonly string[]) => exec(command, args, { cwd: repoRoot }));
  const runStep = deps.step ?? step;
  const restart = deps.restart ?? restartService;
  if (packagedVersion === undefined) {
    const { stdout } = await run("git", ["status", "--porcelain"]);
    if (stdout.trim() !== "") {
      console.error("upgrade: the checkout has uncommitted changes; commit or stash them first");
      process.exitCode = 1;
      return;
    }
    for (const [command, args] of [
      ["git", ["pull", "--ff-only"]],
      ["bun", ["install"]],
      ["bun", ["run", "build"]],
    ] as const) {
      const code = await runStep(command, args);
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
  } else {
    // npm replaces the package in place (same path the service points at) and
    // installs its exact third-party versions; nothing else to rebuild. Aim
    // the install at the prefix that owns this package — the ambient npm
    // prefix may be another one, and the service would keep restarting the
    // old version.
    const prefix = globalPrefixOf(packageDir);
    if (prefix === undefined) {
      console.error(`upgrade: pinomad isn't a global npm install (${packageDir}); upgrade it the way it was installed`);
      process.exitCode = 1;
      return;
    }
    const npm = npmBeside(process.execPath);
    const code = await runStep(npm.command, [...npm.args, "install", "-g", "--prefix", prefix, "pinomad@latest"], npm.binDir);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
  if (!(await (deps.serviceInstalled ?? serviceInstalled)())) {
    console.log("service not installed; upgrade done, nothing restarted");
    process.exitCode = 0;
    return;
  }
  // The restart path exits explicitly: a probe that timed out can leave a
  // pending connection (an endpoint that accepts the socket but never hellos)
  // which would keep the event loop alive past a natural exit.
  (deps.exit ?? process.exit)(
    await restart({ force: values.force, argv: argv.filter((arg) => arg !== "--force") }),
  );
}

if (import.meta.main) {
  // The `bun run upgrade` dev entry bypasses the pinomad dispatcher; report
  // argument errors the same way, other exceptions keep their stack.
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (!isParseArgsError(error)) throw error;
    reportParseArgsError(commandHint("upgrade"), error);
  }
}
