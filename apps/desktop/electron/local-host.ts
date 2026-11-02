// The "This Mac" host switch (#501). The app is only a control panel
// (ADR-0003 §2, ADR-0017): it never bundles or runs a host, it drives the one
// the user installed by running that install's own `pinomad service` CLI. The
// launchd plist names that install — its Node, its script, its PATH — so the
// CLI runs exactly as the service does, whatever this GUI process's PATH is.
// Always execFile/spawn with an argv, never a shell.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { launchdPlistPath, specFromLaunchdPlist, type ServiceSpec } from "../../host/src/service/definition.ts";
import type {
  LocalHostResult,
  LocalHostState,
  LocalHostStopResult,
} from "../../web/src/entities/local-host/local-host-protocol.ts";

type RunOptions = { env: NodeJS.ProcessEnv; cwd: string; timeout?: number };

/** promisify(execFile): rejects with `code` (exit status, or an errno string) plus `stdout`/`stderr`. */
export type ExecFileLike = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }>;

export interface ChildLike {
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
  /** Electron's shell.openPath: resolves to "" on success, an error message otherwise. */
  readonly openPath: (path: string) => Promise<string>;
  readonly tmpdir: string;
  readonly randomId: () => string;
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
  /** Writes a `.command` that installs the host and joins it to `serverOrigin`, and opens it in Terminal. */
  runSetup(serverOrigin: string): Promise<LocalHostResult>;
}

/** Single-quoted for sh: the only character to escape inside '' is ' itself. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

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

// `--code`: the user is signed in here, not in a browser, so they type the
// printed code into the app. `--server` keeps up from asking how devices
// connect. The installer drops pinomad in ~/.local/bin, which this fresh shell
// doesn't have on PATH yet.
const setupScript = (origin: string): string => `#!/bin/sh
# Written by the PiNomad app: installs the PiNomad host on this Mac and adds it to your account.
rm -f -- "$0"
set -e
curl -fsSL https://pinomad.si/install.sh | sh
PATH="$HOME/.local/bin:$PATH"
pinomad up --server --code --origin ${shellQuote(origin)}
`;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The last non-empty stderr line is the CLI's own message; the rest is context. */
const lastLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

/** A non-zero exit: execFile puts the status in a numeric `code`. A string `code` is a spawn errno. */
const exitFailure = (error: unknown): { stderr: string; code: number } | undefined => {
  const { code, stderr } = (error ?? {}) as { code?: unknown; stderr?: unknown };
  return typeof code === "number" ? { code, stderr: typeof stderr === "string" ? stderr : "" } : undefined;
};

/** What the terminal-only Ctrl-C hint becomes here, where Cancel is a button. */
const stopLine = (line: string): string => line.replace(/\s*\(Ctrl-C to cancel\)\s*$/, "");

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

  async function runSetup(serverOrigin: string): Promise<LocalHostResult> {
    const origin = setupOrigin(serverOrigin);
    if (origin === undefined) return { ok: false, message: `Refusing to set up a host for ${serverOrigin}: not an https server.` };
    const path = join(deps.tmpdir, `pinomad-setup-${deps.randomId()}.command`);
    try {
      // wx: never follow or reuse a file someone else put there.
      await writeFile(path, setupScript(origin), { mode: 0o755, flag: "wx" });
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
    const failure = await deps.openPath(path);
    return failure === "" ? { ok: true } : { ok: false, message: failure };
  }

  return { state, start, stop, followStop, cancelStop, runSetup };
}
