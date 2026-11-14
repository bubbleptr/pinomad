// The production wiring of `HostUpgrader` (ADR-0043): the task graph as the
// busy signal, the service manager as the eligibility check, npm for the
// release lookup and the install.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import type { HostSettings } from "@pinomad/protocol/settings.ts";
import type { AutoUpgradeMode, UpgradeBlocker } from "@pinomad/protocol/upgrade.ts";
import { packagedVersion } from "../distribution.ts";
import { Published, type HostValue } from "../host-value.ts";
import { serviceManager, type ServiceManager } from "../service/manager.ts";
import { installCommand, npmBeside, outputTail, packagePrefix, parseRelease, viewCommand, type NpmCommand } from "./npm.ts";
import { HostUpgrader, type HostUpgraderOptions, type InstallResult, type Release } from "./upgrader.ts";

const exec = promisify(execFile);

const withPath = (npm: NpmCommand): NodeJS.ProcessEnv =>
  npm.binDir === undefined ? process.env : { ...process.env, PATH: `${npm.binDir}:${process.env.PATH ?? ""}` };

/** Seams `openHost` takes; everything else is real. */
export interface HostUpgradeOptions {
  /** Close the host and exit with `UPGRADE_EXIT_CODE`. */
  restart(): void;
  blocked?: HostUpgraderOptions["blocked"];
  latest?: HostUpgraderOptions["latest"];
  install?: HostUpgraderOptions["install"];
  every?: HostUpgraderOptions["every"];
}

/**
 * The exit code after a successful install: non-zero, so systemd's
 * `Restart=on-failure` starts the new release like launchd's `KeepAlive`
 * does, without reinstalling existing unit files (ADR-0043 §2). EX_TEMPFAIL.
 */
export const UPGRADE_EXIT_CODE = 75;

/** Why this process can't upgrade itself (ADR-0043 §4). */
export async function upgradeBlocker(
  dataDir: string,
  {
    packaged = packagedVersion !== undefined && packagePrefix() !== undefined,
    manager = serviceManager,
  }: { packaged?: boolean; manager?: () => Pick<ServiceManager, "read" | "state"> } = {},
): Promise<UpgradeBlocker | null> {
  if (!packaged) return "source";
  try {
    const service = manager();
    const spec = await service.read();
    // A service for another data dir doesn't restart this process.
    if (spec === undefined || spec.dataDir !== dataDir) return "no-service";
    const state = await service.state();
    if (!state.installed) return "no-service";
    if (state.stopped) return "stopped";
    // Installed and enabled but not running (e.g. `systemctl --user stop`):
    // this process is a foreground host, and nothing would start it again.
    // The data-dir lock makes a running service for this dir this process.
    return state.running ? null : "no-service";
  } catch {
    return "no-service";
  }
}

export async function latestRelease(): Promise<Release> {
  const npm = viewCommand(npmBeside(process.execPath));
  const { stdout } = await exec(npm.command, [...npm.args], { env: withPath(npm), timeout: 60_000 });
  return parseRelease(stdout);
}

/** `npm install -g pinomad@<version>` into this package's prefix, output kept for a failure message. */
export function installRelease(version: string): Promise<InstallResult> {
  const prefix = packagePrefix();
  if (prefix === undefined) return Promise.resolve({ ok: false, message: "pinomad isn't a global npm install" });
  const npm = installCommand(npmBeside(process.execPath), prefix, `pinomad@${version}`);
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(npm.command, [...npm.args], { env: withPath(npm), stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer): void => {
      // Only the tail is reported; keep it bounded.
      output = (output + chunk.toString("utf8")).slice(-64 * 1024);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => resolve({ ok: false, message: error.message }));
    child.once("exit", (code, signal) =>
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, message: outputTail(output) || `npm exited with ${signal ?? code}` },
      ),
    );
  });
}

/** Live tasks in the task graph, as a boolean. */
async function busyValue(harness: Harness, context: Context): Promise<HostValue<boolean> & { stop(): void }> {
  const watch = await harness.watchTaskGraph(context);
  const busy = new Published(Object.keys(watch.value.tasks).length > 0, (a, b) => a === b);
  watch.start((call) => {
    if (call.kind === "value") busy.set(Object.keys(call.value.tasks).length > 0);
    return Promise.resolve();
  });
  return Object.assign(busy, { stop: () => watch.stop() });
}

/** A boolean source that is true while either input is. */
function mergedBusy(
  tasks: HostValue<boolean> & { stop(): void },
  processes: HostValue<boolean> | undefined,
): HostValue<boolean> & { stop(): void } {
  if (processes === undefined) return tasks;
  const busy = new Published(tasks.value || processes.value, (a, b) => a === b);
  const stopTasks = tasks.subscribe((value) => busy.set(value || processes.value));
  const stopProcesses = processes.subscribe((value) => busy.set(tasks.value || value));
  return Object.assign(busy, {
    stop: () => {
      stopTasks();
      stopProcesses();
      tasks.stop();
    },
  });
}

function modeValue(settings: HostValue<HostSettings>): HostValue<AutoUpgradeMode> & { stop(): void } {
  const mode = new Published<AutoUpgradeMode>(settings.value.autoUpgrade ?? "notify", (a, b) => a === b);
  const stop = settings.subscribe((value) => mode.set(value.autoUpgrade ?? "notify"));
  return Object.assign(mode, { stop });
}

const every: HostUpgraderOptions["every"] = (ms, run) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** The packaged host's upgrader, started; `close` stops its timers and watches. */
export async function startHostUpgrader(options: {
  readonly current: string;
  readonly dataDir: string;
  readonly harness: Harness;
  readonly settings: HostValue<HostSettings>;
  readonly context: Context;
  readonly seams: HostUpgradeOptions;
  /** True while background processes are live (ADR-0045 §5). */
  readonly processesBusy?: HostValue<boolean>;
  /** Stop background processes when an install starts (immediate upgrades). */
  readonly drain?: () => Promise<void>;
}): Promise<HostUpgrader & { close(): void }> {
  const taskBusy = await busyValue(options.harness, options.context);
  const busy = mergedBusy(taskBusy, options.processesBusy);
  const mode = modeValue(options.settings);
  const { seams } = options;
  const upgrader = new HostUpgrader({
    current: options.current,
    protocolMajor: PROTOCOL.major,
    blocked: seams.blocked ?? (() => upgradeBlocker(options.dataDir)),
    latest: seams.latest ?? latestRelease,
    install: seams.install ?? installRelease,
    restart: seams.restart,
    ...(options.drain === undefined ? {} : { drain: options.drain }),
    busy,
    mode,
    now: Date.now,
    every: seams.every ?? every,
  });
  const close = upgrader.close.bind(upgrader);
  upgrader.close = () => {
    close();
    busy.stop();
    mode.stop();
  };
  await upgrader.begin();
  return upgrader;
}
