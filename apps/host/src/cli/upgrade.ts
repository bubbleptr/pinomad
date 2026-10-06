#!/usr/bin/env node
// `bun run upgrade [--force] [--data-dir D] [--url U]` — update this checkout
// and restart the service (ADR-0009 §6). Any failed step stops before the
// restart, so the service keeps running the old code.
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serviceManager } from "../service/manager.ts";
import { restartService } from "./service.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const step = (command: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve) => {
    spawn(command, [...args], { cwd: repoRoot, stdio: "inherit" }).once("exit", (code) => resolve(code ?? 1));
  });

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
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
  // A source checkout without the service still upgrades fine — just no
  // restart; unsupported platforms (serviceManager throws) land here too.
  const installed = await Promise.resolve()
    .then(() => serviceManager().state())
    .then((state) => state.installed, () => false);
  if (!installed) {
    console.log("service not installed; checkout updated, nothing restarted");
    process.exit(0);
  }
  process.exit(await restartService({ force, argv: argv.filter((arg) => arg !== "--force") }));
}
