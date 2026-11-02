#!/usr/bin/env node
// `pinomad service <cmd>` / `bun run service -- <cmd>` — the user-level host
// service (ADR-0009):
//   install [host args…]   write the service definition and start the host
//   uninstall              stop and remove the definition (keeps the data dir)
//   status [--data-dir D] [--url U]
//   restart [--force] [--data-dir D] [--url U]
//   stop [--force]         wait for running tasks, then stop it and keep it off (#501)
//   start                  turn a stopped service back on
//   logs [--follow] [-n N] [--data-dir D]
// status/restart take the same --data-dir/--url flags as link/pair; a host
// installed with non-default args needs them passed here too. stop reads
// them from the installed definition, and `status --json` prints the
// service state alone for the Mac App's switch.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { connectRemoteDurable, ProtocolMismatchError, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { argValue, installSpec } from "../service/definition.ts";
import { waitForIdle } from "../service/idle.ts";
import { serviceManager, type ServiceManager, type ServiceState } from "../service/manager.ts";
import { commandHint, hostEntry, packagedVersion } from "../distribution.ts";
import { isParseArgsError, reportParseArgsError } from "./args.ts";
import { DEFAULT_DATA_DIR, hostAddress } from "./host-address.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A token connection with a deadline; a late winner is closed so it can't hold the event loop open. */
function connectToHost(url: string, token: string, timeoutMs = 3000): Promise<RemoteDurable> {
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
    mainPath: hostEntry.script,
    entryArgs: hostEntry.args,
  });
  const path = await serviceManager().install(spec);
  console.log(`installed ${path}`);
  console.log(`data dir: ${spec.dataDir}`);
  console.log(`browser link: ${commandHint("link")}    pairing QR: ${commandHint("pair")}`);
}

/**
 * ADR-0009 §5: blocks while the host runs tasks, printing what it waits on.
 * A host that doesn't answer is down or crashed, and nothing waits.
 */
async function waitUntilIdle(
  address: { readonly url: string; readonly token: string },
  connect: (url: string, token: string) => Promise<RemoteDurable>,
  log: (line: string) => void,
): Promise<void> {
  try {
    const remote = await connect(address.url, address.token);
    await waitForIdle(remote, (tasks) => {
      log("waiting for running tasks to finish (Ctrl-C to cancel)");
      for (const task of Object.values(tasks.tasks)) {
        log(`  ${task.kind} in conversation ${task.conversationId}`);
      }
    });
    remote.close();
  } catch {
    // Unreachable: go ahead.
  }
}

/**
 * `service stop` (#501): wait until the host is idle, then stop it and keep
 * it off across logins. Without flags the host's address comes from the
 * installed definition, so the Mac App needs none. Returns the exit code.
 */
export async function stopService({
  force,
  argv,
  manager = serviceManager(),
  connect = connectToHost,
  log = (line: string) => console.log(line),
  logError = (line: string) => console.error(line),
}: {
  force: boolean;
  argv: readonly string[];
  manager?: ServiceManager;
  connect?: (url: string, token: string) => Promise<RemoteDurable>;
  log?: (line: string) => void;
  /** stderr: the Mac App shows its last line when the stop fails. */
  logError?: (line: string) => void;
}): Promise<number> {
  const state = await manager.state();
  if (!state.installed) {
    log(`service not installed (${commandHint("service")} install)`);
    return 1;
  }
  if (state.stopped) {
    log("already stopped");
    return 0;
  }
  if (!force) {
    const spec = argv.length === 0 ? await manager.read() : undefined;
    const port = spec === undefined ? undefined : argValue(spec.hostArgs, "--port");
    const flags =
      spec === undefined ? argv : ["--data-dir", spec.dataDir, ...(port === undefined ? [] : ["--url", `ws://127.0.0.1:${port}`])];
    const address = await hostAddress(flags).catch((error: unknown) => {
      if (isParseArgsError(error)) throw error;
      return undefined;
    });
    if (address !== undefined) await waitUntilIdle(address, connect, log);
  }
  // Ctrl-C (the Mac App's Cancel) only interrupts the wait: once launchd's
  // disable ran, stopping before bootout would leave a running host that
  // no longer starts at login.
  const holdInterrupt = (): void => {};
  process.on("SIGINT", holdInterrupt);
  try {
    await manager.stop();
  } finally {
    process.off("SIGINT", holdInterrupt);
  }
  // launchd's bootout can fail after disable went through, leaving the host running.
  const after = await manager.state();
  if (!after.stopped) {
    logError(`the host is still running (${after.detail}); run \`${commandHint("service")} stop\` again`);
    return 1;
  }
  log(`stopped; it stays off, also after a restart, until \`${commandHint("service")} start\``);
  return 0;
}

/** `service start` (#501): turn a stopped service back on. Returns the exit code. */
export async function startService({
  manager = serviceManager(),
  log = (line: string) => console.log(line),
}: {
  manager?: ServiceManager;
  log?: (line: string) => void;
} = {}): Promise<number> {
  if (!(await manager.state()).installed) {
    log(`service not installed (${commandHint("service")} install)`);
    return 1;
  }
  await manager.start();
  log("started");
  return 0;
}

/** `version: 0.12.0`, or the checkout's commit when run from source. */
export async function versionLine(): Promise<string> {
  if (packagedVersion !== undefined) return `version: ${packagedVersion}`;
  const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).then(
    ({ stdout }) => stdout.trim(),
    () => "unknown",
  );
  return `checkout: ${head}`;
}

/** Whether the host answers on its loopback port, and how many tasks it runs. */
export async function reachabilityLine(argv: readonly string[]): Promise<string> {
  try {
    const { url, token } = await hostAddress(argv);
    const remote = await connectToHost(url, token);
    if (remote.view.current().tasks === undefined) await remote.controller.toggleTasks();
    const tasks = remote.view.current().tasks;
    const count = tasks === undefined ? 0 : Object.keys(tasks.tasks).length;
    remote.close();
    return `host: reachable at ${url}, ${count} live task${count === 1 ? "" : "s"}`;
  } catch (error) {
    if (isParseArgsError(error)) throw error;
    return `host: unreachable (${message(error)})`;
  }
}

/** `service status --json`: one line the Mac App's switch parses (#501). */
export const serviceStatusJson = (state: ServiceState): string =>
  JSON.stringify({
    installed: state.installed,
    stopped: state.stopped,
    running: state.running,
    ...(state.pid === undefined ? {} : { pid: state.pid }),
    detail: state.detail,
  });

async function status(argv: readonly string[]): Promise<void> {
  const state = await serviceManager().state();
  if (argv.includes("--json")) {
    console.log(serviceStatusJson(state));
    return;
  }
  console.log(`service: ${state.installed ? state.detail : "not installed"}`);
  console.log(await versionLine());
  console.log(await reachabilityLine(argv));
}

/**
 * Idle-wait then restart through the service manager; returns the exit code.
 * Shared with `upgrade`, which calls it after pull/install/build.
 * `manager` and `restart` are injectable: join/leave pass the manager they
 * resolved and can replace the restart with a definition rewrite + install.
 * `connect` and the poll timings are injectable for tests.
 */
export async function restartService({
  force,
  argv,
  manager = serviceManager(),
  restart,
  connect = connectToHost,
  pollTimeoutMs = 30_000,
  pollDelayMs = 500,
}: {
  force: boolean;
  argv: readonly string[];
  manager?: ServiceManager;
  /** The restart action; defaults to `manager.restart()`. */
  restart?: () => Promise<void>;
  /** The reachability probe; defaults to a token connection to the host. */
  connect?: (url: string, token: string, timeoutMs?: number) => Promise<RemoteDurable>;
  /** Post-restart poll window and spacing; tests shrink both. */
  pollTimeoutMs?: number;
  pollDelayMs?: number;
}): Promise<number> {
  const state = await manager.state();
  if (!state.installed) {
    console.log(`service not installed (${commandHint("service")} install)`);
    return 1;
  }
  // Rewriting the definition turns it back on; a plain restart can't.
  if (state.stopped && restart === undefined) {
    console.log(`service stopped (${commandHint("service")} start)`);
    return 1;
  }
  const address = await hostAddress(argv).catch((error: unknown) => {
    // A bad flag is user error, not "host address unknown" — let the
    // dispatcher report it instead of restarting past it.
    if (isParseArgsError(error)) throw error;
    return undefined;
  });
  if (!force && address !== undefined) await waitUntilIdle(address, connect, (line) => console.log(line));
  await (restart?.() ?? manager.restart());
  if (address === undefined) {
    console.log("restart requested (host address unknown; not polling)");
    return 0;
  }
  const deadline = Date.now() + pollTimeoutMs;
  // The directory lock a crashed host left can take ~12s to be retried away.
  for (;;) {
    try {
      const remote = await connect(address.url, address.token, 2000);
      remote.close();
      console.log(`host restarted, reachable at ${address.url}`);
      return 0;
    } catch (error) {
      // A newer protocol major means the restart landed: the host answers,
      // this build is just too old to speak to it (cross-major upgrades,
      // issue #164). An older major is the old host or a stranger — keep polling.
      if (error instanceof ProtocolMismatchError && error.direction === "client-older") {
        const newer = error.hostVersion ?? `protocol major ${error.hostMajor}`;
        console.log(`host restarted (${newer}, newer than this upgrader), reachable at ${address.url}`);
        return 0;
      }
      if (Date.now() > deadline) {
        console.error(`host did not answer within ${pollTimeoutMs / 1000}s after restart: ${message(error)}`);
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
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

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "install":
        await install(args);
        break;
      case "uninstall":
        await serviceManager().uninstall();
        console.log("uninstalled");
        break;
      case "status":
        await status(args);
        break;
      case "restart": {
        const force = args.includes("--force");
        process.exitCode = await restartService({ force, argv: args.filter((arg) => arg !== "--force") });
        break;
      }
      case "stop": {
        const force = args.includes("--force");
        process.exitCode = await stopService({ force, argv: args.filter((arg) => arg !== "--force") });
        break;
      }
      case "start":
        process.exitCode = await startService();
        break;
      case "logs":
        await logs(args);
        break;
      default:
        console.error(`usage: ${commandHint("service")} install|uninstall|status|restart|stop|start|logs`);
        process.exitCode = 1;
    }
  } catch (error) {
    // Argument errors belong to the `pinomad` dispatcher (exit 2 + hint).
    if (isParseArgsError(error)) throw error;
    console.error(message(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  // The `bun run service` dev entry bypasses the pinomad dispatcher; report
  // argument errors the same way, other exceptions keep their stack.
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (!isParseArgsError(error)) throw error;
    reportParseArgsError(commandHint("service"), error);
  }
}
