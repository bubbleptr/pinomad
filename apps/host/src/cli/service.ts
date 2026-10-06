#!/usr/bin/env node
// `bun run service -- <cmd>` — the user-level host service (ADR-0009):
//   install [host args…]   write the service definition and start the host
//   uninstall              stop and remove the definition (keeps the data dir)
//   status [--data-dir D] [--url U]
//   restart [--force] [--data-dir D] [--url U]
//   logs [--follow] [-n N] [--data-dir D]
// status/restart take the same --data-dir/--url flags as link/pair; a host
// installed with non-default args needs them passed here too.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { connectRemoteDurable, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { installSpec } from "../service/definition.ts";
import { waitForIdle } from "../service/idle.ts";
import { serviceManager } from "../service/manager.ts";
import { DEFAULT_DATA_DIR, hostAddress } from "./host-address.ts";

const run = promisify(execFile);
const mainTs = fileURLToPath(new URL("../main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A token connection with a deadline; a late winner is closed so it can't hold the event loop open. */
function connect(url: string, token: string, timeoutMs = 3000): Promise<RemoteDurable> {
  const connecting = connectRemoteDurable({ url, token, reconnectDelayMs: { min: 200, max: 2000 } });
  const timedOut = Symbol("timedOut");
  return Promise.race([
    connecting,
    new Promise<typeof timedOut>((resolve) => {
      const timer = setTimeout(() => resolve(timedOut), timeoutMs);
      timer.unref();
    }),
  ]).then((winner) => {
    if (winner !== timedOut) return winner;
    void connecting.then((remote) => remote.close(), () => {});
    throw new Error("connect timed out");
  });
}

async function install(argv: readonly string[]): Promise<void> {
  const spec = installSpec(argv, {
    execPath: process.execPath,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    mainPath: mainTs,
  });
  const path = await serviceManager().install(spec);
  console.log(`installed ${path}`);
  console.log(`data dir: ${spec.dataDir}`);
  console.log("browser link: bun run link    pairing QR: bun run pair");
}

async function status(argv: readonly string[]): Promise<void> {
  const state = await serviceManager().state();
  console.log(`service: ${state.installed ? state.detail : "not installed"}`);
  const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).then(
    ({ stdout }) => stdout.trim(),
    () => "unknown",
  );
  console.log(`checkout: ${head}`);
  try {
    const { url, token } = await hostAddress(argv);
    const remote = await connect(url, token);
    if (remote.view.current().tasks === undefined) await remote.controller.toggleTasks();
    const tasks = remote.view.current().tasks;
    const count = tasks === undefined ? 0 : Object.keys(tasks.tasks).length;
    console.log(`host: reachable at ${url}, ${count} live task${count === 1 ? "" : "s"}`);
    remote.close();
  } catch (error) {
    console.log(`host: unreachable (${message(error)})`);
  }
}

/**
 * Idle-wait then restart through the service manager; returns the exit code.
 * Shared with `upgrade`, which calls it after pull/install/build.
 */
export async function restartService({ force, argv }: { force: boolean; argv: readonly string[] }): Promise<number> {
  const manager = serviceManager();
  if (!(await manager.state()).installed) {
    console.log("service not installed (bun run service -- install)");
    return 1;
  }
  const address = await hostAddress(argv).catch(() => undefined);
  if (!force && address !== undefined) {
    try {
      const remote = await connect(address.url, address.token);
      await waitForIdle(remote, (tasks) => {
        console.log("waiting for running tasks to finish (Ctrl-C to cancel)");
        for (const task of Object.values(tasks.tasks)) {
          console.log(`  ${task.kind} in conversation ${task.conversationId}`);
        }
      });
      remote.close();
    } catch {
      // Unreachable — down or crashed; restart straight away.
    }
  }
  await manager.restart();
  if (address === undefined) {
    console.log("restart requested (host address unknown; not polling)");
    return 0;
  }
  const deadline = Date.now() + 30_000;
  // The directory lock a crashed host left can take ~12s to be retried away.
  for (;;) {
    try {
      const remote = await connect(address.url, address.token, 2000);
      remote.close();
      console.log(`host restarted, reachable at ${address.url}`);
      return 0;
    } catch (error) {
      if (Date.now() > deadline) {
        console.error(`host did not answer within 30s after restart: ${message(error)}`);
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function logs(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      follow: { type: "boolean", default: false },
      lines: { type: "string", short: "n", default: "100" },
      "data-dir": { type: "string" },
    },
  });
  const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
  await serviceManager().logs(dataDir, Number(values.lines), values.follow);
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    switch (command) {
      case "install":
        await install(argv);
        break;
      case "uninstall":
        await serviceManager().uninstall();
        console.log("uninstalled");
        break;
      case "status":
        await status(argv);
        break;
      case "restart": {
        const force = argv.includes("--force");
        process.exitCode = await restartService({ force, argv: argv.filter((arg) => arg !== "--force") });
        break;
      }
      case "logs":
        await logs(argv);
        break;
      default:
        console.error("usage: bun run service -- install|uninstall|status|restart|logs");
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}
