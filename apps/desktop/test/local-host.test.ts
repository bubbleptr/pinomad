// The "This Mac" switch drives the host the user installed, through its own
// `pinomad service` CLI. The plist is real (rendered by the host's own
// launchdPlist into a temp home); the CLI runs are fakes, so no launchctl,
// no Terminal, no installer.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { launchdPlist, launchdPlistPath, type ServiceSpec } from "../../host/src/service/definition.ts";
import {
  createLocalHost,
  ENV_PROBE,
  parseShellEnv,
  type ExecFileLike,
  type LocalHostDeps,
  type SpawnLike,
} from "../electron/local-host.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const SERVICE_PATH = "/Users/me/.local/share/pinomad/node/bin:/usr/bin:/bin";

const spec = (home: string, install: "packaged" | "checkout"): ServiceSpec => ({
  nodePath: "/Users/me/.local/share/pinomad/node/bin/node",
  mainPath:
    install === "packaged" ? "/Users/me/.local/share/pinomad/lib/dist/pinomad.js" : "/Users/me/code/pinomad/apps/host/src/main.ts",
  entryArgs: install === "packaged" ? ["host"] : [],
  dataDir: join(home, ".pinomad"),
  hostArgs: ["--remote-port", "7443"],
  env: { PATH: SERVICE_PATH },
  home,
});

async function homeWith(install?: "packaged" | "checkout"): Promise<string> {
  const home = await tempDir("pinomad-local-host-");
  if (install !== undefined) {
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(launchdPlistPath(home), launchdPlist(spec(home, install)));
  }
  return home;
}

type ExecFileResult = { stdout: string; stderr?: string } | { exitCode: number; stdout?: string; stderr: string } | { errno: string };

function fakeExecFile(result: ExecFileResult) {
  return vi.fn<ExecFileLike>(async () => {
    if ("errno" in result) throw Object.assign(new Error(`spawn ${result.errno}`), { code: result.errno });
    if ("exitCode" in result) {
      throw Object.assign(new Error(`Command failed: ${result.stderr}`), {
        code: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr,
      });
    }
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  });
}

/** A child (`service stop`, the installer, `pinomad up`) that prints what the test writes and exits when told. */
function fakeChild() {
  const stdin = new PassThrough();
  let input = "";
  stdin.setEncoding("utf8").on("data", (chunk: string) => (input += chunk));
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin,
    /** Everything written to stdin so far. */
    input: () => input,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => child.exit(null, signal));
      return true;
    }),
    exit(code: number | null, signal: NodeJS.Signals | null = null) {
      child.stdout.end();
      child.stderr.end();
      // After the streams drain, like a real child's "close".
      setImmediate(() => child.emit("close", code, signal));
    },
  });
  return child;
}

function localHost(home: string, overrides: Partial<LocalHostDeps> = {}) {
  const deps: LocalHostDeps = {
    home,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    execFile: fakeExecFile({ stdout: "" }),
    spawn: vi.fn<SpawnLike>(() => {
      throw new Error("no spawn expected");
    }),
    fetchText: vi.fn(async () => INSTALLER),
    killGroup: vi.fn(),
    ...overrides,
  };
  return { host: createLocalHost(deps), deps };
}

const statusLine = (status: object): string => `${JSON.stringify(status)}\n`;

describe("state", () => {
  it("reports not-installed without running any CLI when there is no plist", async () => {
    const { host, deps } = localHost(await homeWith());
    expect(await host.state()).toEqual({ kind: "not-installed" });
    expect(deps.execFile).not.toHaveBeenCalled();
  });

  it("runs a packaged install's CLI through its bundle, with the service PATH", async () => {
    const home = await homeWith("packaged");
    const execFile = fakeExecFile({
      stdout: statusLine({ installed: true, stopped: false, running: true, pid: 4242, detail: "running (pid 4242)" }),
    });
    const { host } = localHost(home, { execFile });

    expect(await host.state()).toEqual({ kind: "installed", running: true, stopped: false, stopping: false, detail: "running (pid 4242)" });
    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe("/Users/me/.local/share/pinomad/node/bin/node");
    expect(args).toEqual(["/Users/me/.local/share/pinomad/lib/dist/pinomad.js", "service", "status", "--json"]);
    expect(options.env.PATH).toBe(SERVICE_PATH);
  });

  it("runs a checkout install's CLI from cli/service.ts next to main.ts", async () => {
    const execFile = fakeExecFile({
      stdout: statusLine({ installed: true, stopped: true, running: false, detail: "stopped" }),
    });
    const { host } = localHost(await homeWith("checkout"), { execFile });

    expect(await host.state()).toEqual({ kind: "installed", running: false, stopped: true, stopping: false, detail: "stopped" });
    expect(execFile.mock.calls[0]![1]).toEqual(["/Users/me/code/pinomad/apps/host/src/cli/service.ts", "status", "--json"]);
  });

  it("calls a pinomad that prints text instead of JSON too old", async () => {
    const execFile = fakeExecFile({ stdout: "service: running (pid 4242)\nhost: reachable\n" });
    const { host } = localHost(await homeWith("packaged"), { execFile });
    expect(await host.state()).toEqual({ kind: "too-old" });
  });

  it("calls a pinomad that rejects --json too old", async () => {
    const execFile = fakeExecFile({ exitCode: 1, stderr: "Unknown option '--json'" });
    const { host } = localHost(await homeWith("packaged"), { execFile });
    expect(await host.state()).toEqual({ kind: "too-old" });
  });

  it("calls JSON of the wrong shape too old", async () => {
    const execFile = fakeExecFile({ stdout: statusLine({ installed: true, running: "yes" }) });
    const { host } = localHost(await homeWith("packaged"), { execFile });
    expect(await host.state()).toEqual({ kind: "too-old" });
  });

  it("reports an error when the service's Node can't be run at all", async () => {
    const execFile = fakeExecFile({ errno: "ENOENT" });
    const { host } = localHost(await homeWith("packaged"), { execFile });
    expect(await host.state()).toMatchObject({ kind: "error" });
  });
});

describe("start", () => {
  it("runs service start and passes its stderr back on failure", async () => {
    const execFile = fakeExecFile({ exitCode: 1, stderr: "launchctl bootstrap failed: 5\n" });
    const { host } = localHost(await homeWith("packaged"), { execFile });

    expect(await host.start()).toEqual({ ok: false, message: "launchctl bootstrap failed: 5" });
    expect(execFile.mock.calls[0]![1]).toEqual(["/Users/me/.local/share/pinomad/lib/dist/pinomad.js", "service", "start"]);
  });

  it("refuses when nothing is installed", async () => {
    const { host, deps } = localHost(await homeWith());
    expect(await host.start()).toMatchObject({ ok: false });
    expect(deps.execFile).not.toHaveBeenCalled();
  });
});

describe("stop", () => {
  it("streams the CLI's lines while it waits and reports stopped on exit 0", async () => {
    const child = fakeChild();
    const spawn = vi.fn<SpawnLike>(() => child);
    const { host } = localHost(await homeWith("packaged"), { spawn });
    let lines: readonly string[] = [];

    const done = host.stop((snapshot) => (lines = snapshot));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.write("waiting for running tasks to finish (Ctrl-C to cancel)\n");
    child.stdout.write("  refactor-auth: running\n");
    child.exit(0);

    expect(await done).toEqual({ outcome: "stopped" });
    expect(lines).toEqual(["waiting for running tasks to finish", "  refactor-auth: running"]);
    expect(spawn.mock.calls[0]![1]).toEqual(["/Users/me/.local/share/pinomad/lib/dist/pinomad.js", "service", "stop"]);
  });

  it("cancel interrupts the CLI, which leaves the service running", async () => {
    const child = fakeChild();
    const spawn = vi.fn<SpawnLike>(() => child);
    const { host } = localHost(await homeWith("packaged"), { spawn });

    const done = host.stop(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    host.cancelStop();

    expect(await done).toEqual({ outcome: "cancelled" });
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("a cancel that comes too late, once the CLI is already stopping the service, reports what happened: stopped", async () => {
    const child = fakeChild();
    // The CLI holds SIGINT once launchd's disable ran, and finishes the stop.
    child.kill.mockImplementation(() => true);
    const spawn = vi.fn<SpawnLike>(() => child);
    const { host } = localHost(await homeWith("packaged"), { spawn });

    const done = host.stop(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    host.cancelStop();
    child.exit(0);

    expect(await done).toEqual({ outcome: "stopped" });
  });

  it("cancel before the CLI starts never starts it", async () => {
    const spawn = vi.fn<SpawnLike>(() => fakeChild());
    const { host } = localHost(await homeWith("packaged"), { spawn });

    const done = host.stop(() => {});
    host.cancelStop();

    expect(await done).toEqual({ outcome: "cancelled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a second stop joins the one already waiting instead of starting another CLI", async () => {
    const child = fakeChild();
    const spawn = vi.fn<SpawnLike>(() => child);
    const { host } = localHost(await homeWith("packaged"), { spawn });

    const first = host.stop(() => {});
    const second = host.stop(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    child.exit(0);
    expect(await first).toEqual({ outcome: "stopped" });
    expect(await second).toEqual({ outcome: "stopped" });
  });

  it("a view that comes back mid-stop sees it in the state and follows it, lines so far included", async () => {
    const child = fakeChild();
    const spawn = vi.fn<SpawnLike>(() => child);
    const execFile = fakeExecFile({ stdout: statusLine({ installed: true, stopped: false, running: true, detail: "running" }) });
    const { host } = localHost(await homeWith("packaged"), { spawn, execFile });

    const first = host.stop(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.write("waiting for running tasks to finish (Ctrl-C to cancel)\n");
    // No CLI round trip: Cancel must show at once, not after a 15s status read.
    await vi.waitFor(async () => expect(await host.state()).toMatchObject({ kind: "installed", stopping: true }));
    expect(execFile).not.toHaveBeenCalled();

    const seen: (readonly string[])[] = [];
    const followed = host.followStop((lines) => seen.push(lines));
    expect(seen).toEqual([["waiting for running tasks to finish"]]);
    child.stdout.write("  refactor-auth: running\n");
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["waiting for running tasks to finish", "  refactor-auth: running"]));
    host.cancelStop();

    expect(await followed).toEqual({ outcome: "cancelled" });
    expect(await first).toEqual({ outcome: "cancelled" });
    expect(await host.state()).toMatchObject({ kind: "installed", stopping: false });
  });

  it("following when no stop is running starts none", async () => {
    const spawn = vi.fn<SpawnLike>(() => fakeChild());
    const { host } = localHost(await homeWith("packaged"), { spawn });

    expect(await host.followStop(() => {})).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports the CLI's stderr when stop fails", async () => {
    const child = fakeChild();
    const spawn = vi.fn<SpawnLike>(() => child);
    const { host } = localHost(await homeWith("packaged"), { spawn });

    const done = host.stop(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stderr.write("couldn't reach the host\n");
    child.exit(1);

    expect(await done).toEqual({ outcome: "failed", message: "couldn't reach the host" });
  });
});

const INSTALLER = "#!/bin/sh\necho installing\n";
const SHELL_PATH = "/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin:/bin";

/** What `$SHELL -ilc` prints: rc chatter first, then the marker and `env -0`, then a .zlogout's goodbye. */
const shellOutput = (): string =>
  "warning: compinit being called again\n__PINOMAD_ENV__" +
  ["HOME=/Users/me", `PATH=${SHELL_PATH}`, "LANG=en_US.UTF-8", "MULTI=a\nb"].map((entry) => `${entry}\0`).join("") +
  "bye\n";

/** The login-shell probe answers with `shellOutput`; anything else is unexpected. */
const shellExec = () =>
  vi.fn<ExecFileLike>(async (file, args) => {
    if (file === "/bin/zsh" && args[0] === "-ilc") return { stdout: shellOutput(), stderr: "" };
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  });

const setupHost = async (overrides: Partial<LocalHostDeps> = {}) => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn = vi.fn<SpawnLike>(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  const home = await homeWith();
  const made = localHost(home, {
    env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    execFile: shellExec(),
    spawn,
    ...overrides,
  });
  return { ...made, home, spawn, children };
};

describe("parseShellEnv", () => {
  // macOS has both; a Linux CI runner may have no zsh.
  it.each(["/bin/sh", "/bin/zsh"].filter((shell) => existsSync(shell)))("reads what the probe prints in a real %s", async (shell) => {
    // An empty ZDOTDIR: no rc file of whoever runs the tests changes PATH.
    const stdout = execFileSync(shell, ["-c", ENV_PROBE], {
      encoding: "utf8",
      env: { PATH: "/opt/x/bin:/usr/bin:/bin", LANG: "de_DE.UTF-8", OTHER: "a=b\nc", ZDOTDIR: await tempDir("pinomad-zdotdir-") },
    });
    expect(parseShellEnv(`noise\n${stdout}`)).toEqual({ PATH: "/opt/x/bin:/usr/bin:/bin", LANG: "de_DE.UTF-8" });
  });
});

describe("install", () => {
  it("runs the downloaded installer with sh on the login shell's PATH, streaming what it prints", async () => {
    const { host, deps, spawn, children } = await setupHost();
    let lines: readonly string[] = [];

    const done = host.install((snapshot) => (lines = snapshot));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const [file, args, options] = spawn.mock.calls[0]!;
    expect([file, args]).toEqual(["/bin/sh", ["-s"]]);
    // The service freezes this PATH (ADR-0009 §4): the user's, not the app's /usr/bin:/bin.
    expect(options.env.PATH).toBe(SHELL_PATH);
    expect(options.env.LANG).toBe("en_US.UTF-8");
    expect(options.env.MULTI).toBeUndefined();
    // Its own process group, so Cancel reaches curl and npm too.
    expect(options.detached).toBe(true);
    expect(deps.fetchText).toHaveBeenCalledWith("https://pinomad.si/install.sh");
    const child = children[0]!;
    await vi.waitFor(() => expect(child.input()).toBe(INSTALLER));
    child.stdout.write("Downloading Node 26.12.1 (darwin-arm64)\n");
    child.stderr.write("npm warn deprecated\n");
    child.exit(0);

    expect(await done).toEqual({ outcome: "done" });
    expect(lines).toEqual(["Downloading Node 26.12.1 (darwin-arm64)", "npm warn deprecated"]);
  });

  it("fails before downloading anything when the login shell's PATH can't be read", async () => {
    const execFile = vi.fn<ExecFileLike>(async () => {
      throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "zsh: no such option" });
    });
    const { host, deps, spawn } = await setupHost({ execFile });

    const result = await host.install(() => {});
    expect(result).toMatchObject({ outcome: "failed", message: expect.stringMatching(/PATH/) });
    expect(deps.fetchText).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("says the installer couldn't be downloaded", async () => {
    const { host, spawn } = await setupHost({ fetchText: vi.fn(async () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) });

    expect(await host.install(() => {})).toEqual({
      outcome: "failed",
      message: "Couldn't download the installer: getaddrinfo ENOTFOUND",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports the installer's own last stderr line when it fails", async () => {
    const { host, spawn, children } = await setupHost();
    const done = host.install(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.stderr.write("install.sh: checksum mismatch for node.tar.gz; nothing was installed\n");
    children[0]!.exit(1);

    expect(await done).toEqual({ outcome: "failed", message: "install.sh: checksum mismatch for node.tar.gz; nothing was installed" });
  });

  it("an installer that dies before reading its script fails the install instead of crashing main", async () => {
    const { host, spawn, children } = await setupHost();
    const done = host.install(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    children[0]!.exit(127);

    expect(await done).toEqual({ outcome: "failed", message: "the installer exited with 127" });
  });

  it("cancel kills the installer's whole process group", async () => {
    const { host, deps, spawn, children } = await setupHost();
    const done = host.install(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    host.cancelInstall();
    expect(deps.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    children[0]!.exit(null, "SIGTERM");
    expect(await done).toEqual({ outcome: "cancelled" });
  });

  it("cancel before the installer starts never starts it", async () => {
    const { host, spawn } = await setupHost();
    const done = host.install(() => {});
    host.cancelInstall();

    expect(await done).toEqual({ outcome: "cancelled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a second install joins the running one, lines so far included", async () => {
    const { host, spawn, children } = await setupHost();
    const first = host.install(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.stdout.write("Installing pinomad@latest\n");
    await vi.waitFor(async () => {
      let seen: readonly string[] = [];
      void host.install((lines) => (seen = lines));
      expect(seen).toEqual(["Installing pinomad@latest"]);
    });
    const second = host.install(() => {});
    children[0]!.exit(0);

    expect(await first).toEqual({ outcome: "done" });
    expect(await second).toEqual({ outcome: "done" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("join", () => {
  it("runs pinomad up with the token on stdin, never in argv, ~/.local/bin first on the shell's PATH", async () => {
    const { host, home, spawn, children } = await setupHost();
    const done = host.join("https://app.pinomad.si/some/path?x=1", "join-7f3a9c");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const [file, args, options] = spawn.mock.calls[0]!;
    // Only the origin survives.
    expect([file, args]).toEqual(["pinomad", ["up", "--server", "--origin", "https://app.pinomad.si", "--token-stdin"]]);
    expect(options.env.PATH).toBe(`${join(home, ".local", "bin")}:${SHELL_PATH}`);
    await vi.waitFor(() => expect(children[0]!.input()).toBe("join-7f3a9c\n"));
    children[0]!.exit(0);

    expect(await done).toEqual({ ok: true });
  });

  it("allows plain http on localhost for development", async () => {
    const { host, spawn, children } = await setupHost();
    const done = host.join("http://127.0.0.1:8787", "join-7f3a9c");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.exit(0);
    expect(await done).toEqual({ ok: true });
  });

  it.each([
    "not a url",
    "http://pinomad.si",
    "ftp://pinomad.si",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://192.168.1.4:8080",
  ])("refuses %s and runs nothing", async (origin) => {
    const { host, spawn } = await setupHost();
    expect(await host.join(origin, "join-7f3a9c")).toMatchObject({ ok: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a pinomad from before --token-stdin says to upgrade, not its stack trace", async () => {
    const { host, spawn, children } = await setupHost();
    const done = host.join("https://app.pinomad.si", "join-7f3a9c");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.stderr.write(
      "node:internal/util/parse_args/parse_args:98\n" +
        "TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--token-stdin'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--token-stdin\"\n" +
        "\nNode.js v26.12.1\n",
    );
    children[0]!.exit(1);

    expect(await done).toEqual({ ok: false, message: expect.stringContaining("pinomad upgrade") });
  });

  it("from the installed app, the service runs through the app's launcher", async () => {
    const launcher = "/Applications/PiNomad.app/Contents/Helpers/PiNomad Host.app/Contents/MacOS/pinomad-host";
    const { host, spawn, children } = await setupHost({ launcher });
    const done = host.join("https://app.pinomad.si", "join-7f3a9c");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(spawn.mock.calls[0]![1]).toEqual([
      "up",
      "--server",
      "--origin",
      "https://app.pinomad.si",
      "--token-stdin",
      "--launcher",
      launcher,
    ]);
    children[0]!.exit(0);
    expect(await done).toEqual({ ok: true });
  });

  it("a pinomad from before --launcher still joins, the token unspent by the first try", async () => {
    const { host, spawn, children } = await setupHost({ launcher: "/Applications/PiNomad.app/x" });
    const done = host.join("https://app.pinomad.si", "join-7f3a9c");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    children[0]!.stderr.write("TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--launcher'. To specify …\n");
    children[0]!.exit(1);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn.mock.calls[1]![1]).toEqual(["up", "--server", "--origin", "https://app.pinomad.si", "--token-stdin"]);
    await vi.waitFor(() => expect(children[1]!.input()).toBe("join-7f3a9c\n"));
    children[1]!.exit(0);
    expect(await done).toEqual({ ok: true });
  });

  it("reports the CLI's last stderr line when the join fails", async () => {
    const { host, spawn, children } = await setupHost();
    const done = host.join("https://app.pinomad.si", "join-7f3a9c");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.stderr.write("the join token expired — generate a fresh one\n");
    children[0]!.exit(1);

    expect(await done).toEqual({ ok: false, message: "the join token expired — generate a fresh one" });
  });
});
