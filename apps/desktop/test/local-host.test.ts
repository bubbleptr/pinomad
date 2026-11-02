// The "This Mac" switch drives the host the user installed, through its own
// `pinomad service` CLI. The plist is real (rendered by the host's own
// launchdPlist into a temp home); the CLI runs are fakes, so no launchctl,
// no Terminal.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { launchdPlist, launchdPlistPath, type ServiceSpec } from "../../host/src/service/definition.ts";
import {
  createLocalHost,
  shellQuote,
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

/** A `service stop` child that prints what the test writes and exits when told. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
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
  let id = 0;
  const deps: LocalHostDeps = {
    home,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    execFile: fakeExecFile({ stdout: "" }),
    spawn: vi.fn<SpawnLike>(() => {
      throw new Error("no spawn expected");
    }),
    openPath: vi.fn(async () => ""),
    tmpdir: home,
    randomId: () => `id${++id}`,
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

describe("runSetup", () => {
  it.each([
    "not a url",
    "http://pinomad.si",
    "ftp://pinomad.si",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://192.168.1.4:8080",
  ])("refuses %s and writes nothing", async (origin) => {
    const home = await homeWith();
    const { host, deps } = localHost(home);

    expect(await host.runSetup(origin)).toMatchObject({ ok: false });
    expect(deps.openPath).not.toHaveBeenCalled();
    await expect(stat(join(home, "pinomad-setup-id1.command"))).rejects.toThrow();
  });

  it("writes an executable .command for the server's origin and opens it", async () => {
    const home = await homeWith();
    const { host, deps } = localHost(home);

    expect(await host.runSetup("https://app.pinomad.si/some/path?x=1")).toEqual({ ok: true });

    const path = join(home, "pinomad-setup-id1.command");
    expect(deps.openPath).toHaveBeenCalledWith(path);
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    const script = await readFile(path, "utf8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    // Only the origin survives, quoted for the shell.
    expect(script).toContain("pinomad up --server --code --origin 'https://app.pinomad.si'\n");
    expect(script).not.toContain("/some/path");
  });

  it("allows plain http on localhost for development", async () => {
    const { host } = localHost(await homeWith());
    expect(await host.runSetup("http://127.0.0.1:8787")).toEqual({ ok: true });
    expect(await host.runSetup("http://localhost:8787")).toEqual({ ok: true });
  });

  it("reports Terminal refusing to open the file", async () => {
    const { host } = localHost(await homeWith(), { openPath: async () => "Failed to open path" });
    expect(await host.runSetup("https://pinomad.si")).toEqual({ ok: false, message: "Failed to open path" });
  });
});

describe("shellQuote", () => {
  it.each(["https://pinomad.si", "it's", "$(touch /tmp/x)`id`", "a'b'c", ""])("round-trips %j through sh", (value) => {
    expect(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" })).toBe(value);
  });
});
