// The launcher the host service runs through on macOS (host-launcher/). It
// stays node's parent so macOS asks for file access in the app's name; the
// service manager only ever signals the launcher, so the host's graceful stop
// and its exit status both depend on it passing them through.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../host-launcher/pinomad-host.c", import.meta.url));

const hasCompiler = (() => {
  try {
    execFileSync("cc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasCompiler)("pinomad-host launcher", () => {
  let dir: string;
  let launcher: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinomad-launcher-"));
    launcher = join(dir, "pinomad-host");
    execFileSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, source]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    const child = spawn(launcher, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on("close", (code, signal) => resolve({ code, signal })),
    );
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  }

  it("runs the program with its arguments and exits with its status", async () => {
    const { exited, stdout } = run(["/bin/sh", "-c", 'echo "$1"; exit 7', "sh", "an argument"]);
    expect(await exited).toEqual({ code: 7, signal: null });
    expect(stdout()).toBe("an argument\n");
  });

  it("passes SIGTERM on and waits for the program's own shutdown", async () => {
    const script = "trap 'echo stopping; exit 0' TERM; echo ready; while :; do sleep 0.05; done";
    const { child, exited, stdout } = run(["/bin/sh", "-c", script]);
    await expect.poll(stdout).toContain("ready");
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout()).toContain("stopping");
  });

  it("dies of the signal that killed the program", async () => {
    const { exited } = run(["/bin/sh", "-c", "kill -KILL $$"]);
    expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("says which program it couldn't start", async () => {
    const { exited, stderr } = run([join(dir, "no-such-node")]);
    expect((await exited).code).toBe(127);
    expect(stderr()).toContain("no-such-node");
  });
});
