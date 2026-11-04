// The "This Mac" host switch (#501). The app is only a control panel
// (ADR-0003 §2, ADR-0017): it never bundles or runs a host, it drives the one
// the user installed by running that install's own `pinomad service` CLI.
// What it does ship is a launcher the service runs node through, so macOS
// asks for file access as PiNomad rather than node (host-launcher/). The
// launchd plist names that install — its Node, its script, its PATH — so the
// CLI runs exactly as the service does, whatever this GUI process's PATH is.
// Setting a host up runs install.sh and `pinomad up` in the background on
// the login shell's PATH, which the service then keeps (ADR-0009 §4).
// Always execFile/spawn with an argv, never a shell.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { launchdPlistPath, specFromLaunchdPlist, type ServiceSpec } from "../../host/src/service/definition.ts";
import type {
  LocalHostResult,
  LocalHostSetupResult,
  LocalHostState,
  LocalHostStopResult,
} from "../../web/src/entities/local-host/local-host-protocol.ts";

type RunOptions = { env: NodeJS.ProcessEnv; cwd: string; timeout?: number; detached?: boolean };

/** promisify(execFile): rejects with `code` (exit status, or an errno string) plus `stdout`/`stderr`. */
export type ExecFileLike = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }>;

export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnLike = (file: string, args: string[], options: RunOptions) => ChildLike;

export interface LocalHostDeps {
  readonly home: string;
  /** The app's environment; only PATH is replaced, with the service's. */
  readonly env: NodeJS.ProcessEnv;
  readonly execFile: ExecFileLike;
  readonly spawn: SpawnLike;
  /** GETs a URL's body as text; rejects on a network error or a non-2xx answer. */
  readonly fetchText: (url: string) => Promise<string>;
  /** Signals a detached child's whole process group. */
  readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** This app's host launcher, for the service it sets up; undefined when the app has none to offer (dev, not in Applications). */
  readonly launcher?: string | undefined;
}

export interface LocalHost {
  state(): Promise<LocalHostState>;
  start(): Promise<LocalHostResult>;
  /**
   * `service stop`, which first waits for running tasks; `onLines` gets every
   * line it printed so far, each time one arrives. While a stop is running a
   * second call joins it.
   */
  stop(onLines: (lines: readonly string[]) => void): Promise<LocalHostStopResult>;
  /** Joins the running stop, like `stop` but never starting one; undefined when none is running. */
  followStop(onLines: (lines: readonly string[]) => void): Promise<LocalHostStopResult | undefined>;
  /** Interrupts a stop still waiting for tasks; the CLI then leaves the service running. Once it is stopping the service, the CLI finishes. */
  cancelStop(): void;
  /**
   * Runs install.sh in the background; `onLines` gets everything it printed
   * so far, each time a line arrives. While an install is running a second
   * call joins it.
   */
  install(onLines: (lines: readonly string[]) => void): Promise<LocalHostSetupResult>;
  /** Kills a running install, curl and npm included. */
  cancelInstall(): void;
  /** `pinomad up` with a one-time join token: joins `serverOrigin` and installs the service, nobody confirming a code. */
  join(serverOrigin: string, token: string): Promise<LocalHostResult>;
}

export const INSTALLER_URL = "https://pinomad.si/install.sh";

const TOO_OLD_TO_JOIN =
  "The pinomad on this Mac is too old to be set up from the app. Run pinomad upgrade in a terminal, then try again.";

const CHECKOUT_MAIN = /(^|\/)apps\/host\/src\/main\.ts$/;

/**
 * The service CLI of the install a plist names: a packaged bundle takes the
 * `service` subcommand where the service passes `host`; a checkout runs
 * `cli/service.ts` beside `main.ts`.
 */
function serviceArgv(spec: ServiceSpec, command: readonly string[]): string[] | undefined {
  if (spec.entryArgs.length === 1 && spec.entryArgs[0] === "host") return [spec.mainPath, "service", ...command];
  if (spec.entryArgs.length === 0 && CHECKOUT_MAIN.test(spec.mainPath)) {
    return [join(dirname(spec.mainPath), "cli", "service.ts"), ...command];
  }
  return undefined;
}

type Status = { installed: boolean; stopped: boolean; running: boolean; detail: string };

/** One JSON line from `service status --json`; anything else came from a pinomad too old to print it. */
function parseStatus(stdout: string): Status | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { installed, stopped, running, detail } = value as Record<string, unknown>;
  if (typeof installed !== "boolean" || typeof stopped !== "boolean" || typeof running !== "boolean") return undefined;
  if (typeof detail !== "string") return undefined;
  return { installed, stopped, running, detail };
}

/** `https:`, or `http:` on this machine for development; anything else never reaches the script. */
function setupOrigin(serverOrigin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(serverOrigin);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return url.origin;
  return undefined;
}

const ENV_MARKER = "__PINOMAD_ENV__";
/** Valid in sh, zsh, bash and fish; the marker cuts off what rc files print first. */
export const ENV_PROBE = `printf '%s' ${ENV_MARKER}; command env -0`;
/** What the service definition keeps of the installing environment (definition.ts). */
const SHELL_ENV_KEYS = ["PATH", "LANG", "LC_ALL"] as const;

/** The variables `env -0` printed after the marker; a .zlogout's output after the last NUL is dropped. */
export function parseShellEnv(stdout: string): Partial<Record<(typeof SHELL_ENV_KEYS)[number], string>> | undefined {
  const start = stdout.indexOf(ENV_MARKER);
  if (start === -1) return undefined;
  const entries = stdout.slice(start + ENV_MARKER.length).split("\0").slice(0, -1);
  const env: Partial<Record<(typeof SHELL_ENV_KEYS)[number], string>> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const key = entry.slice(0, eq) as (typeof SHELL_ENV_KEYS)[number];
    if (eq > 0 && SHELL_ENV_KEYS.includes(key)) env[key] = entry.slice(eq + 1);
  }
  return env.PATH === undefined ? undefined : env;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The last non-empty stderr line is the CLI's own message; the rest is context. */
const lastLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

/** The flag an older pinomad's strict parser stopped at. */
const unknownOption = (stderr: string): string | undefined => /Unknown option '(--[a-z-]+)'/.exec(stderr)?.[1];

/** A non-zero exit: execFile puts the status in a numeric `code`. A string `code` is a spawn errno. */
const exitFailure = (error: unknown): { stderr: string; code: number } | undefined => {
  const { code, stderr } = (error ?? {}) as { code?: unknown; stderr?: unknown };
  return typeof code === "number" ? { code, stderr: typeof stderr === "string" ? stderr : "" } : undefined;
};

/** What the terminal-only Ctrl-C hint becomes here, where Cancel is a button. */
const stopLine = (line: string): string => line.replace(/\s*\(Ctrl-C to cancel\)\s*$/, "");

/**
 * Hands a child its stdin and closes it. A child that exits before reading
 * it all makes the write fail with EPIPE; unheard, that error would crash
 * main. Its exit status says what went wrong.
 */
function feed(child: ChildLike, input?: string): void {
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
}

/** Every non-empty line a stream prints, as it arrives. */
function onLinesOf(stream: Readable | null, push: (line: string) => void): void {
  if (stream !== null) createInterface({ input: stream }).on("line", (line) => line.trim() !== "" && push(line));
}

export function createLocalHost(deps: LocalHostDeps): LocalHost {
  type StopRun = {
    cancelled: boolean;
    child?: ChildLike;
    /** What the CLI printed so far, kept for a view that comes back mid-stop. */
    lines: string[];
    listeners: Set<(lines: readonly string[]) => void>;
  };
  let stopping: { run: StopRun; result: Promise<LocalHostStopResult> } | undefined;

  type Cli = { file: string; args: (command: readonly string[]) => string[]; options: RunOptions };

  /** Undefined when no plist is installed; throws when the plist names no install this app knows. */
  async function cli(): Promise<Cli | undefined> {
    let text: string;
    try {
      text = await readFile(launchdPlistPath(deps.home), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const spec = specFromLaunchdPlist(text);
    if (serviceArgv(spec, []) === undefined) {
      throw new Error(`The host service runs ${spec.mainPath}, which isn't an install this app knows how to control.`);
    }
    return {
      file: spec.nodePath,
      args: (command) => serviceArgv(spec, command)!,
      options: { env: { ...deps.env, PATH: spec.env.PATH }, cwd: spec.home },
    };
  }

  async function state(): Promise<LocalHostState> {
    let target: Cli | undefined;
    try {
      target = await cli();
    } catch (error) {
      return { kind: "error", message: errorMessage(error) };
    }
    if (target === undefined) return { kind: "not-installed" };
    // The CLI still reports it running; Cancel must show without a status round trip.
    if (stopping !== undefined) return { kind: "installed", running: true, stopped: false, stopping: true, detail: "stopping" };
    let stdout: string;
    try {
      // status connects to the host with its own 3s deadline.
      ({ stdout } = await deps.execFile(target.file, target.args(["status", "--json"]), { ...target.options, timeout: 15_000 }));
    } catch (error) {
      // An older CLI's strict parser rejects --json with a non-zero exit.
      if (exitFailure(error) !== undefined) return { kind: "too-old" };
      return { kind: "error", message: `Couldn't run the installed pinomad: ${errorMessage(error)}` };
    }
    const status = parseStatus(stdout);
    if (status === undefined) return { kind: "too-old" };
    if (!status.installed) return { kind: "not-installed" };
    return { kind: "installed", running: status.running, stopped: status.stopped, stopping: false, detail: status.detail };
  }

  async function start(): Promise<LocalHostResult> {
    try {
      const target = await cli();
      if (target === undefined) return { ok: false, message: "The PiNomad host isn't installed on this Mac." };
      await deps.execFile(target.file, target.args(["start"]), { ...target.options, timeout: 60_000 });
      return { ok: true };
    } catch (error) {
      const failure = exitFailure(error);
      const message = failure === undefined ? errorMessage(error) : (lastLine(failure.stderr) ?? `pinomad exited with ${failure.code}`);
      return { ok: false, message };
    }
  }

  function follow({ run, result }: NonNullable<typeof stopping>, onLines: (lines: readonly string[]) => void) {
    run.listeners.add(onLines);
    if (run.lines.length > 0) onLines([...run.lines]);
    return result;
  }

  function stop(onLines: (lines: readonly string[]) => void): Promise<LocalHostStopResult> {
    if (stopping !== undefined) return follow(stopping, onLines);
    // Claimed before the first await, so a second stop or a Cancel lands on this one.
    const run: StopRun = { cancelled: false, lines: [], listeners: new Set() };
    stopping = { run, result: runStop(run).finally(() => (stopping = undefined)) };
    return follow(stopping, onLines);
  }

  async function followStop(onLines: (lines: readonly string[]) => void): Promise<LocalHostStopResult | undefined> {
    return stopping === undefined ? undefined : follow(stopping, onLines);
  }

  async function runStop(run: StopRun): Promise<LocalHostStopResult> {
    try {
      const target = await cli();
      if (target === undefined) return { outcome: "failed", message: "The PiNomad host isn't installed on this Mac." };
      if (run.cancelled) return { outcome: "cancelled" };
      const child = deps.spawn(target.file, target.args(["stop"]), target.options);
      run.child = child;
      feed(child);
      let stderr = "";
      if (child.stdout !== null) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          if (line.trim() === "") return;
          run.lines.push(stopLine(line));
          for (const listener of run.listeners) listener([...run.lines]);
        });
      }
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      return await new Promise<LocalHostStopResult>((resolve) => {
        child.on("error", (error) => resolve({ outcome: "failed", message: errorMessage(error) }));
        child.on("close", (code) => {
          // The CLI ignores a Cancel that lands once it is stopping the service; it exits 0 then.
          if (code === 0) resolve({ outcome: "stopped" });
          else if (run.cancelled) resolve({ outcome: "cancelled" });
          else resolve({ outcome: "failed", message: lastLine(stderr) ?? `pinomad exited with ${code ?? "a signal"}` });
        });
      });
    } catch (error) {
      return { outcome: "failed", message: errorMessage(error) };
    }
  }

  function cancelStop(): void {
    if (stopping === undefined) return;
    stopping.run.cancelled = true;
    // Ctrl-C, as in a terminal: the CLI gives up waiting and leaves the service on.
    stopping.run.child?.kill("SIGINT");
  }

  /**
   * The environment Terminal would give the install: this app's, with PATH
   * (and the locale) from an interactive login shell, where Homebrew, nvm or
   * bun put theirs. A Finder-launched app has only /usr/bin:/bin, and the
   * service would keep that for the agent's bash.
   */
  let shellEnv: Promise<NodeJS.ProcessEnv> | undefined;
  function loginEnv(): Promise<NodeJS.ProcessEnv> {
    shellEnv ??= (async () => {
      const shell = deps.env.SHELL?.startsWith("/") === true ? deps.env.SHELL : "/bin/zsh";
      let stdout: string;
      try {
        ({ stdout } = await deps.execFile(shell, ["-ilc", ENV_PROBE], { env: deps.env, cwd: deps.home, timeout: 15_000 }));
      } catch (error) {
        const failure = exitFailure(error);
        const detail = failure === undefined ? errorMessage(error) : (lastLine(failure.stderr) ?? `${shell} exited with ${failure.code}`);
        throw new Error(`Couldn't read the PATH from your shell (${shell}): ${detail}`);
      }
      const env = parseShellEnv(stdout);
      if (env === undefined) throw new Error(`Couldn't read the PATH from your shell (${shell}): it printed no environment.`);
      return { ...deps.env, ...env };
    })();
    // Only a read that worked is kept: Try again asks the shell again.
    shellEnv.catch(() => (shellEnv = undefined));
    return shellEnv;
  }

  type InstallRun = { cancelled: boolean; child?: ChildLike; lines: string[]; listeners: Set<(lines: readonly string[]) => void> };
  let installing: { run: InstallRun; result: Promise<LocalHostSetupResult> } | undefined;

  function install(onLines: (lines: readonly string[]) => void): Promise<LocalHostSetupResult> {
    // Claimed before the first await, so a second install or a Cancel lands on this one.
    if (installing === undefined) {
      const run: InstallRun = { cancelled: false, lines: [], listeners: new Set() };
      installing = { run, result: runInstall(run).finally(() => (installing = undefined)) };
    }
    const { run, result } = installing;
    run.listeners.add(onLines);
    if (run.lines.length > 0) onLines([...run.lines]);
    return result;
  }

  async function runInstall(run: InstallRun): Promise<LocalHostSetupResult> {
    let env: NodeJS.ProcessEnv;
    let script: string;
    try {
      env = await loginEnv();
      if (run.cancelled) return { outcome: "cancelled" };
      try {
        script = await deps.fetchText(INSTALLER_URL);
      } catch (error) {
        throw new Error(`Couldn't download the installer: ${errorMessage(error)}`);
      }
    } catch (error) {
      return { outcome: "failed", message: errorMessage(error) };
    }
    if (run.cancelled) return { outcome: "cancelled" };
    // `curl … | sh` without the pipe: sh reads the script it was handed.
    // Its own process group, so Cancel also reaches the curl and npm it runs.
    const child = deps.spawn("/bin/sh", ["-s"], { env, cwd: deps.home, detached: true });
    run.child = child;
    feed(child, script);
    let stderr = "";
    const push = (line: string): void => {
      run.lines.push(line);
      for (const listener of run.listeners) listener([...run.lines]);
    };
    onLinesOf(child.stdout, push);
    onLinesOf(child.stderr, (line) => {
      stderr += `${line}\n`;
      push(line);
    });
    return new Promise<LocalHostSetupResult>((resolve) => {
      child.on("error", (error) => resolve({ outcome: "failed", message: errorMessage(error) }));
      child.on("close", (code) => {
        if (code === 0) resolve({ outcome: "done" });
        else if (run.cancelled) resolve({ outcome: "cancelled" });
        else resolve({ outcome: "failed", message: lastLine(stderr) ?? `the installer exited with ${code ?? "a signal"}` });
      });
    });
  }

  function cancelInstall(): void {
    if (installing === undefined) return;
    installing.run.cancelled = true;
    const pid = installing.run.child?.pid;
    if (pid === undefined) return;
    try {
      deps.killGroup(pid, "SIGTERM");
    } catch {
      // ESRCH: it exited on its own meanwhile; close reports that.
    }
  }

  // Not `join`: that is path.join here.
  async function joinAccount(serverOrigin: string, token: string): Promise<LocalHostResult> {
    const origin = setupOrigin(serverOrigin);
    if (origin === undefined) return { ok: false, message: `Refusing to set up a host for ${serverOrigin}: not an https server.` };
    let env: NodeJS.ProcessEnv;
    try {
      env = await loginEnv();
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
    let run = await runUp(origin, token, env, deps.launcher);
    // A pinomad from before --launcher stops at the flag, before spending the
    // token: join again without it, and the service runs node directly.
    if ("code" in run && unknownOption(run.stderr) === "--launcher") run = await runUp(origin, token, env, undefined);
    if ("error" in run) return { ok: false, message: `Couldn't run pinomad: ${errorMessage(run.error)}` };
    if (run.code === 0) return { ok: true };
    // A pinomad from npm that install.sh left alone may predate the flags.
    if (unknownOption(run.stderr) !== undefined) return { ok: false, message: TOO_OLD_TO_JOIN };
    return { ok: false, message: lastLine(run.stderr) ?? `pinomad exited with ${run.code ?? "a signal"}` };
  }

  function runUp(
    origin: string,
    token: string,
    env: NodeJS.ProcessEnv,
    launcher: string | undefined,
  ): Promise<{ code: number | null; stderr: string } | { error: Error }> {
    // The installer's launcher, unless a pinomad from npm is on the shell's PATH
    // instead (install.sh then leaves it alone). `--server` asks nothing.
    const args = ["up", "--server", "--origin", origin, "--token-stdin", ...(launcher === undefined ? [] : ["--launcher", launcher])];
    const child = deps.spawn("pinomad", args, {
      env: { ...env, PATH: `${join(deps.home, ".local", "bin")}:${env.PATH ?? ""}` },
      cwd: deps.home,
    });
    // stdin, not argv: any process on this Mac can read another's argv.
    feed(child, `${token}\n`);
    child.stdout?.resume();
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    return new Promise((resolve) => {
      child.on("error", (error) => resolve({ error }));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  }

  return { state, start, stop, followStop, cancelStop, install, cancelInstall, join: joinAccount };
}
