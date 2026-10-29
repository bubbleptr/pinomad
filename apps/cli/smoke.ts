#!/usr/bin/env bun
// `bun apps/cli/smoke.ts <pinomad-x.y.z.tgz>` — install the tarball globally
// into a temp prefix and exercise the packaged entry points. Needs registry
// access (external deps install at `npm i -g` time); not part of bun run test.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPiStack } from "./src/pi-stack.ts";

const fail = (message: string): never => {
  console.error(`smoke: ${message}`);
  process.exit(1);
};

const tgz = process.argv[2];
if (tgz === undefined) fail("usage: bun apps/cli/smoke.ts <pinomad-*.tgz>");
const version = /^pinomad-(.+)\.tgz$/.exec(basename(tgz))?.[1];
if (version === undefined) fail(`cannot read version from ${tgz}`);
const root = fileURLToPath(new URL("../..", import.meta.url));
const pi = await hostPiStack(root);

type InstalledPi = { readonly path: string; readonly version: string };

/** Read every physical @earendil-works package under one node_modules tree. */
async function scanPi(nodeModules: string, found: Map<string, InstalledPi[]>): Promise<void> {
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const dirs = entry.name.startsWith("@")
      ? (await readdir(join(nodeModules, entry.name), { withFileTypes: true }))
          .filter((child) => child.isDirectory())
          .map((child) => join(nodeModules, entry.name, child.name))
      : [join(nodeModules, entry.name)];
    for (const dir of dirs) {
      const manifestPath = join(dir, "package.json");
      let manifest: { name?: string; version?: string };
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string; version?: string };
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw error;
      }
      if (manifest.name?.startsWith("@earendil-works/")) {
        if (manifest.version === undefined) throw new Error(`${manifestPath} has no version`);
        const copies = found.get(manifest.name) ?? [];
        copies.push({ path: dir, version: manifest.version });
        found.set(manifest.name, copies);
      }
      await scanPi(join(dir, "node_modules"), found);
    }
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

const run = (command: string, args: readonly string[]): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.once("exit", (code) => resolve({ code: code ?? 1, output }));
  });

/** Spawn a long-running subcommand; resolve once stdout prints the ready line. */
function untilReady(command: string, args: readonly string[], env?: Record<string, string>, timeoutMs = 30_000): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: { ...process.env, ...env } });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`no ready line within ${timeoutMs}ms; output: ${output}`)), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk;
      if (output.includes('"event":"ready"')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before ready; output: ${output}`));
    });
    child.once("error", reject);
  });
}

const stop = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });

const get = async (port: number): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  return { status: response.status, body: await response.text() };
};

const prefix = await mkdtemp(join(tmpdir(), "pinomad-smoke-prefix-"));
const work = await mkdtemp(join(tmpdir(), "pinomad-smoke-data-"));
try {
  const install = await run("npm", ["install", "-g", "--prefix", prefix, tgz]);
  if (install.code !== 0) fail(`npm install failed:\n${install.output}`);

  const installed = new Map<string, InstalledPi[]>();
  await scanPi(join(prefix, "lib", "node_modules"), installed);
  for (const [name, pinnedVersion] of pi.packages) {
    const copies = installed.get(name) ?? [];
    if (copies.length !== 1) {
      fail(
        `${name}: expected one copy at ${pinnedVersion}, found ${copies.length}` +
          (copies.length === 0 ? "" : ` (${copies.map((copy) => copy.path).join(", ")})`),
      );
    }
    if (copies[0]!.version !== pinnedVersion) {
      fail(`${name}: installed ${copies[0]!.version}, expected ${pinnedVersion}`);
    }
  }
  for (const name of installed.keys()) {
    if (!pi.packages.has(name)) fail(`${name}: not in the pinned pi stack`);
  }
  console.log(`smoke: pi stack ${pi.version} — ${pi.packages.size} packages, one copy each`);

  const bin = join(prefix, "bin", "pinomad");

  const ver = await run(bin, ["--version"]);
  if (ver.code !== 0 || ver.output.trim() !== version) fail(`--version printed ${JSON.stringify(ver.output)}`);

  const hostPort = await freePort();
  const host = await untilReady(bin, ["host", "--faux", "hi", "--data-dir", work, "--port", String(hostPort)]);
  const index = await get(hostPort);
  if (index.status !== 200 || !index.body.includes("<")) fail(`GET / on packaged host: ${index.status}`);
  await stop(host);

  const relayPort = await freePort();
  // First start: the bootstrap env vars create the account in a fresh data dir.
  const relay = await untilReady(
    bin,
    ["server", "--public-origin", `http://127.0.0.1:${relayPort}`, "--data-dir", join(work, "server"), "--port", String(relayPort)],
    { PINOMAD_SERVER_USER: "smoke", PINOMAD_SERVER_PASSWORD: "smoke-password-long-enough" },
  );
  const relayIndex = await get(relayPort);
  if (relayIndex.status !== 200 || !relayIndex.body.includes("<")) fail(`GET / on packaged server: ${relayIndex.status}`);
  await stop(relay);

  console.log(`smoke ok: pinomad@${version} (version, host+web, server+web)`);
} finally {
  await rm(prefix, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
