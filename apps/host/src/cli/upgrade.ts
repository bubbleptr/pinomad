#!/usr/bin/env node
// `pinomad upgrade` / `bun run upgrade` [--force] [--data-dir D] [--url U] —
// update and restart the service (ADR-0009 §6, amended by ADR-0016 and
// ADR-0043); one that `service stop` turned off only updates (#501). A
// packaged install whose service runs and answers asks the host to upgrade
// itself and follows it (`--force` → now); otherwise packaged installs pull
// `pinomad@latest` from npm here, and a source checkout pulls git +
// reinstalls deps + rebuilds. Any failed step stops before the restart, so
// the service keeps running the old code.
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { commandHint, packageDir, packagedVersion } from "../distribution.ts";
import { serviceManager } from "../service/manager.ts";
import type { ServiceState } from "../service/manager.ts";
import { installCommand, npmBeside, packagePrefix } from "../upgrade/npm.ts";
import { isParseArgsError, reportParseArgsError } from "./args.ts";
import { hostAddress, hostAddressOptions } from "./host-address.ts";
import { awaitRestarted, connectToHost, restartService } from "./service.ts";
import { upgradeWithHost } from "./upgrade-via-host.ts";

export { npmBeside } from "../upgrade/npm.ts";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const step = (command: string, args: readonly string[], binDir?: string): Promise<number> =>
  new Promise((resolve) => {
    const env = binDir === undefined ? process.env : { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    spawn(command, [...args], { cwd: repoRoot, env, stdio: "inherit" }).once("exit", (code) => resolve(code ?? 1));
  });

type UpgradeServiceState = Pick<ServiceState, "installed" | "stopped">;

// A source checkout / global install without the service still upgrades
// fine — just no restart; unsupported platforms (serviceManager throws)
// land here too.
const serviceState = (): Promise<UpgradeServiceState> =>
  Promise.resolve()
    .then(() => serviceManager().state())
    .catch(() => ({ installed: false, stopped: false }));

export interface UpgradeDeps {
  /** One-shot exec for the `git status` check; defaults to execFile in the repo root. */
  readonly run?: (command: string, args: readonly string[]) => Promise<{ stdout: string }>;
  /** A foreground step (npm/git/bun, stdio inherit), `binDir` first on its PATH; injected so tests never run them. */
  readonly step?: (command: string, args: readonly string[], binDir?: string) => Promise<number>;
  /** Whether the user service is installed and turned on; defaults to asking the platform manager. */
  readonly serviceState?: () => Promise<UpgradeServiceState>;
  /** The post-install restart; defaults to `restartService`. */
  readonly restart?: (options: { force: boolean; argv: readonly string[] }) => Promise<number>;
  /** The exit after a restart ran; defaults to `process.exit`, injected by tests. */
  readonly exit?: (code: number) => void;
  /**
   * The upgrade through the running host (ADR-0043 §8): its exit code, or
   * undefined to upgrade here instead. Defaults to `upgradeThroughHost`.
   */
  readonly viaHost?: (argv: readonly string[], force: boolean) => Promise<number | undefined>;
}

/**
 * Asks the running packaged service to upgrade itself. Undefined — upgrade
 * locally — when no service runs, the host doesn't answer, or
 * `upgradeWithHost` hands the upgrade back.
 */
export async function upgradeThroughHost(argv: readonly string[], force: boolean): Promise<number | undefined> {
  const service = await serviceState();
  if (!service.installed || service.stopped) return undefined;
  // `--force` is upgrade's own flag; the address parser rejects it.
  const address = await hostAddress(argv.filter((arg) => arg !== "--force")).catch(() => undefined);
  if (address === undefined) return undefined;
  const remote = await connectToHost(address.url, address.token).catch(() => undefined);
  if (remote === undefined) return undefined;
  try {
    let cancel: (() => Promise<void>) | undefined;
    const interrupt = (): void => {
      if (cancel === undefined) process.exit(130);
      void cancel().finally(() => {
        console.log("upgrade cancelled");
        process.exit(130);
      });
    };
    process.on("SIGINT", interrupt);
    const outcome = await upgradeWithHost(remote, force ? "now" : "idle", (line) => console.log(line), (c) => (cancel = c))
      .finally(() => process.off("SIGINT", interrupt));
    if (outcome === undefined) return undefined;
    switch (outcome.kind) {
      case "current":
        console.log(`already on the latest release (${outcome.version ?? "unknown"})`);
        return 0;
      case "failed":
        console.error(`upgrade failed; the host keeps running the old version:\n${outcome.message}`);
        return 1;
      case "cancelled":
        console.log("the upgrade was cancelled on another device");
        return 1;
      case "restarting":
        return awaitRestarted(address);
    }
  } finally {
    remote.close();
  }
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
    const viaHost = await (deps.viaHost ?? upgradeThroughHost)(argv, values.force);
    if (viaHost !== undefined) {
      (deps.exit ?? process.exit)(viaHost);
      return;
    }
    // npm replaces the package in place (same path the service points at) and
    // installs its exact third-party versions; nothing else to rebuild. Aim
    // the install at the prefix that owns this package — the ambient npm
    // prefix may be another one, and the service would keep restarting the
    // old version.
    const prefix = packagePrefix();
    if (prefix === undefined) {
      console.error(`upgrade: pinomad isn't a global npm install (${packageDir}); upgrade it the way it was installed`);
      process.exitCode = 1;
      return;
    }
    const npm = installCommand(npmBeside(process.execPath), prefix, "pinomad@latest");
    const code = await runStep(npm.command, npm.args, npm.binDir);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
  const service = await (deps.serviceState ?? serviceState)();
  if (!service.installed) {
    console.log("service not installed; upgrade done, nothing restarted");
    process.exitCode = 0;
    return;
  }
  // `service stop` (#501) keeps it off; the next start runs the new code.
  if (service.stopped) {
    console.log(`service stopped; upgrade done, it stays off until \`${commandHint("service")} start\``);
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
