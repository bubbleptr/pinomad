// Platform commands behind `bun run service` (ADR-0009): launchd on macOS,
// systemd user units on Linux. The host stays a foreground process; the
// service manager owns keepalive and log capture.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  launchdPlist,
  launchdPlistPath,
  specFromLaunchdPlist,
  specFromSystemdUnit,
  type ServiceSpec,
  systemdUnit,
  systemdUnitPath,
} from "./definition.ts";

const run = promisify(execFile);

export interface ServiceState {
  /** False when there is no service definition at all. */
  readonly installed: boolean;
  /**
   * Installed but turned off with `service stop` (#501): it stays off across
   * logins until `service start`, or a join or `up` that writes the service.
   */
  readonly stopped: boolean;
  readonly running: boolean;
  readonly pid?: number;
  /** One line for `service status`, e.g. "running, pid 1234". */
  readonly detail: string;
}

export interface ServiceManager {
  /** Write the definition and load it; returns the definition's path. */
  install(spec: ServiceSpec): Promise<string>;
  /** Unload and remove the definition; never touches the data dir. */
  uninstall(): Promise<void>;
  restart(): Promise<void>;
  /** Turns an installed service back on, at login too; a running one stays as it is. */
  start(): Promise<void>;
  /** Stops it and keeps it off across logins; the definition and data dir stay. */
  stop(): Promise<void>;
  state(): Promise<ServiceState>;
  logs(dataDir: string, lines: number, follow: boolean): Promise<void>;
  /**
   * Reads the installed definition back into a spec — join/leave rewrite it.
   * Undefined when nothing is installed; throws on an unparseable file.
   */
  read(): Promise<ServiceSpec | undefined>;
}

const NOT_INSTALLED: ServiceState = { installed: false, stopped: false, running: false, detail: "not installed" };

/**
 * Whether `launchctl print-disabled` lists pinomad.host as disabled: the
 * override `service stop` sets so the agent stays off at the next login.
 * macOS prints `=> disabled`; older releases printed `=> true`.
 */
export function launchdDisabled(printed: string): boolean {
  const value = /^\s*"pinomad\.host" => (\w+)\s*$/m.exec(printed)?.[1];
  return value === "disabled" || value === "true";
}

/**
 * The service state from `print-disabled` and `launchctl print` (undefined
 * when the label isn't loaded). Stopped means disabled and unloaded: disable
 * alone leaves a running host running, as when `service stop`'s bootout
 * failed, and a second stop must still be able to finish it.
 */
export function launchdState(disabled: boolean, printed: string | undefined): ServiceState {
  if (printed === undefined) {
    return disabled
      ? { installed: true, stopped: true, running: false, detail: "stopped" }
      : { installed: true, stopped: false, running: false, detail: "not loaded" };
  }
  const field = (name: string): string | undefined => printed.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1];
  const state = field("state") ?? "unknown";
  const pid = field("pid");
  const exit = field("last exit code");
  return {
    installed: true,
    stopped: false,
    running: state === "running" && pid !== undefined,
    ...(pid === undefined ? {} : { pid: Number(pid) }),
    detail: [
      state,
      ...(pid === undefined ? [] : [`pid ${pid}`]),
      ...(exit === undefined || exit === "0" || exit === "(never exited)" ? [] : [`last exit ${exit}`]),
      ...(disabled ? ["turned off but still loaded"] : []),
    ].join(", "),
  };
}

/** macOS: ~/Library/LaunchAgents/pinomad.host.plist, gui/<uid>/pinomad.host. */
const launchd: ServiceManager = {
  async install(spec) {
    await mkdir(join(spec.dataDir, "logs"), { recursive: true });
    const path = launchdPlistPath(spec.home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, launchdPlist(spec));
    const domain = `gui/${process.getuid!()}/pinomad.host`;
    // A previous install may or may not be loaded; bootout's failure is fine.
    await run("launchctl", ["bootout", domain]).catch(() => {});
    // A `service stop` left it disabled, and bootstrap refuses a disabled
    // label: writing the service (join, up, upgrade) turns it back on.
    await run("launchctl", ["enable", domain]);
    await run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
    return path;
  },

  async uninstall() {
    // Not loaded is not an error: uninstall stays idempotent.
    await run("launchctl", ["bootout", `gui/${process.getuid!()}/pinomad.host`]).catch(() => {});
    await rm(launchdPlistPath(homedir()), { force: true });
  },

  async restart() {
    await run("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/pinomad.host`]);
  },

  async start() {
    const domain = `gui/${process.getuid!()}/pinomad.host`;
    await run("launchctl", ["enable", domain]);
    // Already loaded (running, or waiting to be relaunched): nothing to bootstrap.
    if (await run("launchctl", ["print", domain]).then(() => true, () => false)) return;
    await run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, launchdPlistPath(homedir())]);
  },

  async stop() {
    const domain = `gui/${process.getuid!()}/pinomad.host`;
    // Disabled first: RunAtLoad would otherwise bring it back at the next login.
    await run("launchctl", ["disable", domain]);
    await run("launchctl", ["bootout", domain]).catch(() => {});
  },

  async state() {
    const defined = await readFile(launchdPlistPath(homedir())).then(
      () => true,
      () => false,
    );
    if (!defined) return NOT_INSTALLED;
    const disabled = await run("launchctl", ["print-disabled", `gui/${process.getuid!()}`]).then(
      ({ stdout }) => launchdDisabled(stdout),
      () => false,
    );
    const printed = await run("launchctl", ["print", `gui/${process.getuid!()}/pinomad.host`]).then(
      ({ stdout }) => stdout,
      () => undefined,
    );
    return launchdState(disabled, printed);
  },

  async logs(dataDir, lines, follow) {
    const file = join(dataDir, "logs", "host.log");
    if (follow) {
      const tail = spawn("tail", ["-f", "-n", String(lines), file], { stdio: "inherit" });
      await new Promise<void>((resolve) => tail.once("exit", () => resolve()));
      return;
    }
    const text = await readFile(file, "utf8");
    const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    process.stdout.write(`${all.slice(-lines).join("\n")}\n`);
  },

  async read() {
    const text = await readFile(launchdPlistPath(homedir()), "utf8").then(
      (value) => value,
      (error: unknown) => ((error as { code?: string }).code === "ENOENT" ? undefined : Promise.reject(error)),
    );
    return text === undefined ? undefined : specFromLaunchdPlist(text);
  },
};

/** Linux: ~/.config/systemd/user/pinomad.service. */
const systemd: ServiceManager = {
  async install(spec) {
    const path = systemdUnitPath(spec.home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, systemdUnit(spec));
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "pinomad.service"]);
    await run("systemctl", ["--user", "restart", "pinomad.service"]);
    const user = process.env.USER ?? userInfo().username;
    const linger = await run("loginctl", ["show-user", user, "-p", "Linger"]).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    );
    // Without linger the unit stops at logout; enabling it needs privileges we don't take.
    if (linger === "Linger=no") {
      console.log(`Note: run \`loginctl enable-linger ${user}\` to keep the host running while logged out.`);
    }
    return path;
  },

  async uninstall() {
    await run("systemctl", ["--user", "disable", "--now", "pinomad.service"]).catch(() => {});
    await rm(systemdUnitPath(homedir()), { force: true });
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  },

  async restart() {
    await run("systemctl", ["--user", "restart", "pinomad.service"]);
  },

  async start() {
    await run("systemctl", ["--user", "enable", "--now", "pinomad.service"]);
  },

  async stop() {
    await run("systemctl", ["--user", "disable", "--now", "pinomad.service"]);
  },

  async state() {
    const shown = await run("systemctl", [
      "--user",
      "show",
      "pinomad.service",
      "-p",
      "LoadState,ActiveState,SubState,MainPID,ExecMainStatus,UnitFileState",
    ]).then(
      ({ stdout }) => stdout,
      () => undefined,
    );
    if (shown === undefined) return NOT_INSTALLED;
    const fields = Object.fromEntries(shown.trim().split("\n").map((line) => line.split("=", 2) as [string, string]));
    if (fields.LoadState === "not-found") return NOT_INSTALLED;
    const pid = Number(fields.MainPID ?? "0");
    const active = fields.ActiveState === "active";
    if (fields.UnitFileState === "disabled" && !active) return { installed: true, stopped: true, running: false, detail: "stopped" };
    return {
      installed: true,
      stopped: false,
      running: active && pid > 0,
      ...(pid > 0 ? { pid } : {}),
      detail: [
        fields.ActiveState ?? "unknown",
        fields.SubState ?? "",
        ...(pid > 0 ? [`pid ${pid}`] : []),
        ...(fields.ExecMainStatus === undefined || fields.ExecMainStatus === "0" ? [] : [`last exit ${fields.ExecMainStatus}`]),
      ]
        .filter((part) => part !== "")
        .join(", "),
    };
  },

  async logs(_dataDir, lines, follow) {
    const journal = spawn("journalctl", ["--user", "-u", "pinomad.service", "-n", String(lines), ...(follow ? ["-f"] : [])], {
      stdio: "inherit",
    });
    await new Promise<void>((resolve) => journal.once("exit", () => resolve()));
  },

  async read() {
    const text = await readFile(systemdUnitPath(homedir()), "utf8").then(
      (value) => value,
      (error: unknown) => ((error as { code?: string }).code === "ENOENT" ? undefined : Promise.reject(error)),
    );
    return text === undefined ? undefined : specFromSystemdUnit(text);
  },
};

export function serviceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === "darwin") return launchd;
  if (platform === "linux") return systemd;
  throw new Error(`service commands support macOS and Linux, not ${platform}`);
}
