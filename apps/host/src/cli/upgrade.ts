#!/usr/bin/env node
// `pinomad upgrade` / `bun run upgrade` [--force] [--data-dir D] [--url U] —
// update and restart the service (ADR-0009 §6, amended by ADR-0016). Packaged
// installs pull `pinomad@latest` from npm; a source checkout pulls git +
// reinstalls deps + rebuilds. Any failed step stops before the restart, so
// the service keeps running the old code.
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { globalPrefixOf, packageDir, packagedVersion } from "../distribution.ts";
import { serviceManager } from "../service/manager.ts";
import { restartService } from "./service.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const step = (command: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve) => {
    spawn(command, [...args], { cwd: repoRoot, stdio: "inherit" }).once("exit", (code) => resolve(code ?? 1));
  });

export async function main(argv: readonly string[]): Promise<void> {
  const force = argv.includes("--force");
  if (packagedVersion === undefined) {
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: repoRoot });
    if (stdout.trim() !== "") {
      console.error("upgrade: the checkout has uncommitted changes; commit or stash them first");
      process.exit(1);
    }
    for (const [command, args] of [
      ["git", ["pull", "--ff-only"]],
      ["bun", ["install"]],
      ["bun", ["run", "build"]],
    ] as const) {
      const code = await step(command, args);
      if (code !== 0) process.exit(code);
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
      process.exit(1);
    }
    const code = await step("npm", ["install", "-g", "--prefix", prefix, "pinomad@latest"]);
    if (code !== 0) process.exit(code);
  }
  // A source checkout / global install without the service still upgrades
  // fine — just no restart; unsupported platforms (serviceManager throws)
  // land here too.
  const installed = await Promise.resolve()
    .then(() => serviceManager().state())
    .then((state) => state.installed, () => false);
  if (!installed) {
    console.log("service not installed; upgrade done, nothing restarted");
    process.exit(0);
  }
  process.exit(await restartService({ force, argv: argv.filter((arg) => arg !== "--force") }));
}

if (import.meta.main) await main(process.argv.slice(2));
