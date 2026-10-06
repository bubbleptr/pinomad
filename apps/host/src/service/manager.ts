// Platform commands behind `bun run service` (ADR-0009): launchd on macOS,
// systemd user units on Linux. The host stays a foreground process; the
// service manager owns keepalive and log capture.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { launchdPlist, launchdPlistPath, type ServiceSpec, systemdUnit, systemdUnitPath } from "./definition.ts";

const run = promisify(execFile);

export interface ServiceState {
  /** False when the service manager has no such unit at all. */
  readonly installed: boolean;
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
  state(): Promise<ServiceState>;
  logs(dataDir: string, lines: number, follow: boolean): Promise<void>;
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

  async state() {
    const printed = await run("launchctl", ["print", `gui/${process.getuid!()}/pinomad.host`]).then(
      ({ stdout }) => stdout,
      () => undefined,
    );
    if (printed === undefined) return { installed: false, running: false, detail: "not installed" };
    const field = (name: string): string | undefined =>
      printed.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1];
    const state = field("state") ?? "unknown";
    const pid = field("pid");
    const exit = field("last exit code");
    return {
      installed: true,
      running: state === "running" && pid !== undefined,
      ...(pid === undefined ? {} : { pid: Number(pid) }),
      detail: [
        state,
        ...(pid === undefined ? [] : [`pid ${pid}`]),
        ...(exit === undefined || exit === "0" || exit === "(never exited)" ? [] : [`last exit ${exit}`]),
      ].join(", "),
    };
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

  async state() {
    const shown = await run("systemctl", [
      "--user",
      "show",
      "pinomad.service",
      "-p",
      "LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
    ]).then(
      ({ stdout }) => stdout,
      () => undefined,
    );
    if (shown === undefined) return { installed: false, running: false, detail: "not installed" };
    const fields = Object.fromEntries(shown.trim().split("\n").map((line) => line.split("=", 2) as [string, string]));
    if (fields.LoadState === "not-found") return { installed: false, running: false, detail: "not installed" };
    const pid = Number(fields.MainPID ?? "0");
    return {
      installed: true,
      running: fields.ActiveState === "active" && pid > 0,
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
};

export function serviceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === "darwin") return launchd;
  if (platform === "linux") return systemd;
  throw new Error(`service commands support macOS and Linux, not ${platform}`);
}
