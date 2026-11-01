// public/install.sh (#499) runs as `curl … | sh`, so it is tested that way:
// piped into `sh` with HOME, PATH and the Node mirror pointed at temp dirs.
// Nothing here reaches the network. A real install (official Node, the packed
// pinomad, a host that starts) runs in the release workflow on every platform.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../public/install.sh", import.meta.url));
// Only system tools: whatever pinomad or node the developer has stays out.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// The script stops before any download on an Intel Mac.
const hasBuild = !(process.platform === "darwin" && process.arch === "x64");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pinomad-install-"));
  dirs.push(dir);
  return dir;
}

async function runInstaller(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const text = await readFile(script, "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(text);
  });
}

async function nodeVersion(): Promise<string> {
  const match = /^NODE_VERSION=(\S+)$/m.exec(await readFile(script, "utf8"));
  if (match === null) throw new Error("install.sh pins no NODE_VERSION");
  return match[1]!;
}

describe("install.sh", () => {
  it.skipIf(!hasBuild)("refuses a Node download whose checksum doesn't match and installs nothing", async () => {
    const home = await tempDir();
    const mirror = await tempDir();
    const version = await nodeVersion();
    await mkdir(join(mirror, `v${version}`));
    for (const platform of ["darwin-arm64", "linux-x64", "linux-arm64"]) {
      await writeFile(join(mirror, `v${version}`, `node-v${version}-${platform}.tar.gz`), "not the real node");
    }

    const run = await runInstaller({ HOME: home, PATH: SYSTEM_PATH, PINOMAD_NODE_MIRROR: pathToFileURL(mirror).href });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/checksum/i);
    expect(existsSync(join(home, ".pinomad", "runtime", "node"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "pinomad"))).toBe(false);
  });

  it("leaves a pinomad installed another way alone, before downloading anything", async () => {
    const home = await tempDir();
    const npmBin = await tempDir();
    const npmPinomad = join(npmBin, "pinomad");
    await writeFile(npmPinomad, "#!/usr/bin/env node\nconsole.log('0.9.0')\n");
    await chmod(npmPinomad, 0o755);

    const run = await runInstaller({
      HOME: home,
      PATH: `${npmBin}:${SYSTEM_PATH}`,
      PINOMAD_NODE_MIRROR: pathToFileURL(join(home, "no-mirror")).href,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(npmPinomad);
    expect(run.stdout).toContain("pinomad upgrade");
    expect(existsSync(join(home, ".pinomad", "runtime"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "pinomad"))).toBe(false);
  });

  it.skipIf(!hasBuild)("treats its own launcher on PATH as a re-install", async () => {
    const home = await tempDir();
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    // An earlier run's launcher; the empty mirror then stops this run at the Node download.
    const launcher = join(bin, "pinomad");
    await writeFile(launcher, "#!/bin/sh\n# pinomad launcher installed by https://pinomad.si/install.sh\nexit 1\n");
    await chmod(launcher, 0o755);

    const run = await runInstaller({
      HOME: home,
      PATH: `${bin}:${SYSTEM_PATH}`,
      PINOMAD_NODE_MIRROR: pathToFileURL(join(home, "no-mirror")).href,
    });

    expect(run.stdout).not.toContain("leaving it alone");
    expect(run.stdout).toContain("Downloading Node");
    expect(run.code).not.toBe(0);
  });
});
