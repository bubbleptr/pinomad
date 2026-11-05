// public/install.sh (#499) runs as `curl … | sh`, so it is tested that way:
// piped into `sh` with HOME, PATH and the Node mirror pointed at temp dirs.
// Nothing here reaches the network. A real install (official Node, the packed
// pinomad, a host that starts) runs in the release workflow on every platform.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../public/install.sh", import.meta.url));
// Only system tools: whatever pinomad or node the developer has stays out.
const SYSTEM_PATH = "/usr/bin:/bin";
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

async function runInstaller(
  env: Record<string, string>,
  args: readonly string[] = [],
  { shell = "/bin/sh", cwd, text }: { shell?: string; cwd?: string; text?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  text ??= await readFile(script, "utf8");
  return new Promise((resolve, reject) => {
    // `sh -s -- …` is how the apps pass a command through. Detached, so the
    // script finds no /dev/tty even when the tests run in a terminal. `env`
    // replaces the environment outright, as `env -i` would.
    const child = spawn(shell, args.length === 0 ? [] : ["-s", "--", ...args], {
      env,
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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

/**
 * A node that plays npm (it lays down pinomad.js under `runtime`) and pinomad
 * (it prints its arguments and the PATH it was given).
 */
async function fakeNode(path: string, runtime: string): Promise<void> {
  const entry = join(runtime, "lib", "node_modules", "pinomad", "dist", "pinomad.js");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh
case "$1" in
  --version) echo v${await nodeVersion()} ;;
  */npm-cli.js) mkdir -p "${join(entry, "..")}" && : >"${entry}" ;;
  */pinomad.js) shift; if [ "$1" = --version ]; then echo 0.0.0-test; else echo "pinomad ran with: $*"; echo "PATH=$PATH"; fi ;;
esac
`,
  );
  await chmod(path, 0o755);
}

/**
 * A runtime whose Node already has the pinned version, so the script skips the
 * download (the platform check still runs first, hence skipIf(!hasBuild)).
 */
async function fakeRuntime(runtime: string): Promise<void> {
  await fakeNode(join(runtime, "node", "bin", "node"), runtime);
}

const nodePlatform = `${process.platform}-${process.arch}`;

/**
 * A file:// mirror serving a Node tarball whose node is fakeNode, and the
 * script with its checksums swapped for the tarball's, so the download, the
 * unpack and the cleanup after it all run for real.
 */
async function fakeMirror(runtime: string): Promise<{ mirror: string; text: string }> {
  const version = await nodeVersion();
  const name = `node-v${version}-${nodePlatform}`;
  const staging = await tempDir();
  await fakeNode(join(staging, name, "bin", "node"), runtime);
  const mirror = await tempDir();
  await mkdir(join(mirror, `v${version}`));
  const tarball = join(mirror, `v${version}`, `${name}.tar.gz`);
  // COPYFILE_DISABLE keeps macOS tar from adding ._ entries.
  await execFileAsync("tar", ["-czf", tarball, "-C", staging, name], {
    env: { PATH: SYSTEM_PATH, COPYFILE_DISABLE: "1" },
  });
  const sum = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const text = (await readFile(script, "utf8")).replace(/^(SUM_\w+)=\w+$/gm, `$1=${sum}`);
  return { mirror: pathToFileURL(mirror).href, text };
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

  describe("PATH", () => {
    it.skipIf(!hasBuild)("adds ~/.local/bin to the shell profile once, however often it runs", async () => {
      const home = await tempDir();
      await fakeRuntime(join(home, ".pinomad", "runtime"));
      const env = { HOME: home, PATH: SYSTEM_PATH, SHELL: "/bin/zsh" };

      const first = await runInstaller(env);
      const second = await runInstaller(env);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const zshrc = await readFile(join(home, ".zshrc"), "utf8");
      expect(zshrc.match(/\.local\/bin/g)).toHaveLength(1);
      expect(zshrc).toContain('export PATH="$HOME/.local/bin:$PATH"');
      expect(second.stdout).toMatch(/new terminal.*pinomad up/);
    });

    it.skipIf(!hasBuild)("leaves the profile alone when ~/.local/bin is already on PATH", async () => {
      const home = await tempDir();
      await fakeRuntime(join(home, ".pinomad", "runtime"));

      const run = await runInstaller({
        HOME: home,
        PATH: `${join(home, ".local", "bin")}:${SYSTEM_PATH}`,
        SHELL: "/bin/zsh",
      });

      expect(run.code).toBe(0);
      expect(existsSync(join(home, ".zshrc"))).toBe(false);
      expect(run.stdout).toContain("Next: pinomad up");
    });
  });

  it.skipIf(!hasBuild)("runs pinomad with the arguments after `sh -s --` once it is installed", async () => {
    const home = await tempDir();
    await fakeRuntime(join(home, ".pinomad", "runtime"));

    const run = await runInstaller({ HOME: home, PATH: SYSTEM_PATH, SHELL: "/bin/zsh" }, [
      "up",
      "--origin",
      "https://accounts.example.com",
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("pinomad ran with: up --origin https://accounts.example.com");
    expect(run.stdout).not.toContain("Next:");
  });

  // A bare environment (only HOME and the system PATH), under /bin/sh and
  // dash, which is /bin/sh on Debian and Ubuntu and is the stricter of the two.
  for (const shell of ["/bin/sh", "/bin/dash"]) {
    describe.skipIf(!existsSync(shell))(`in a bare environment under ${shell}`, () => {
      it("runs the arguments with a pinomad installed another way, and installs nothing", async () => {
        const home = await tempDir();
        const npmBin = await tempDir();
        await writeFile(join(npmBin, "pinomad"), '#!/bin/sh\necho "npm pinomad ran with: $*"\n');
        await chmod(join(npmBin, "pinomad"), 0o755);

        const run = await runInstaller(
          { HOME: home, PATH: `${npmBin}:${SYSTEM_PATH}`, PINOMAD_NODE_MIRROR: pathToFileURL(join(home, "no-mirror")).href },
          ["up", "--origin", "https://accounts.example.com"],
          { shell },
        );

        expect(run.code).toBe(0);
        expect(run.stdout).toContain(join(npmBin, "pinomad"));
        expect(run.stdout).toContain("pinomad upgrade");
        expect(run.stdout).toContain("npm pinomad ran with: up --origin https://accounts.example.com");
        expect(existsSync(join(home, ".pinomad", "runtime"))).toBe(false);
        expect(existsSync(join(home, ".local", "bin", "pinomad"))).toBe(false);
      });

      it.skipIf(!hasBuild)("installs without SHELL set", async () => {
        const home = await tempDir();
        await fakeRuntime(join(home, ".pinomad", "runtime"));

        const run = await runInstaller({ HOME: home, PATH: SYSTEM_PATH }, ["--version"], { shell });

        expect(run.stderr).toBe("");
        expect(run.code).toBe(0);
        expect(run.stdout).toContain("0.0.0-test");
        // bash, /bin/sh on macOS, fills SHELL in from the user database; dash
        // leaves it unset, which means ~/.profile.
        if (shell === "/bin/dash") {
          expect(await readFile(join(home, ".profile"), "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
        }
      });

      it.skipIf(!hasBuild)("writes a launcher that works from any directory when PINOMAD_RUNTIME_DIR is relative", async () => {
        const home = await tempDir();
        // pwd resolves symlinks (macOS's /var is one), so the launcher records the real path.
        const work = await realpath(await tempDir());
        const runtime = join(work, "rt");
        await fakeRuntime(runtime);

        const install = await runInstaller({ HOME: home, PATH: SYSTEM_PATH, PINOMAD_RUNTIME_DIR: "./rt" }, [], { shell, cwd: work });
        expect(install.code).toBe(0);

        const { stdout } = await execFileAsync(join(home, ".local", "bin", "pinomad"), ["up"], {
          cwd: await tempDir(),
          env: { HOME: home, PATH: SYSTEM_PATH },
        });
        expect(stdout).toContain("pinomad ran with: up");
        // The bundled Node is on the launcher's PATH, after the system's.
        expect(stdout).toContain(`PATH=${SYSTEM_PATH}:${join(runtime, "node", "bin")}`);
      });

      it.skipIf(!hasBuild)("leaves no download behind when it goes on to run a command", async () => {
        const home = await tempDir();
        const runtime = join(home, ".pinomad", "runtime");
        const { mirror, text } = await fakeMirror(runtime);

        const run = await runInstaller({ HOME: home, PATH: SYSTEM_PATH, PINOMAD_NODE_MIRROR: mirror }, ["up"], { shell, text });

        expect(run.stderr).toBe("");
        expect(run.code).toBe(0);
        expect(run.stdout).toContain("Downloading Node");
        expect(run.stdout).toContain("pinomad ran with: up");
        expect((await readdir(runtime)).sort()).toEqual(["lib", "node"]);
      });
    });
  }
});
