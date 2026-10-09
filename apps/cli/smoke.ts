#!/usr/bin/env bun
// `bun apps/cli/smoke.ts <pinomad-x.y.z.tgz>` — install the tarball globally
// into a temp prefix and exercise the packaged entry points. Needs registry
// access (external deps install at `npm i -g` time); not part of bun run test.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message: string): never => {
  console.error(`smoke: ${message}`);
  process.exit(1);
};

const tgz = process.argv[2];
if (tgz === undefined) fail("usage: bun apps/cli/smoke.ts <pinomad-*.tgz>");
const version = /pinomad-(.+)\.tgz$/.exec(tgz)?.[1];
if (version === undefined) fail(`cannot read version from ${tgz}`);

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
function untilReady(command: string, args: readonly string[], timeoutMs = 30_000): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args]);
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
  const bin = join(prefix, "bin", "pinomad");

  const ver = await run(bin, ["--version"]);
  if (ver.code !== 0 || ver.output.trim() !== version) fail(`--version printed ${JSON.stringify(ver.output)}`);

  const relayId = await run(bin, ["relay-id", "--data-dir", work]);
  const hostId = relayId.output.trim();
  if (relayId.code !== 0 || !/^[A-Za-z0-9_-]{43}$/.test(hostId)) fail(`relay-id printed ${JSON.stringify(relayId.output)}`);

  const hostPort = await freePort();
  const host = await untilReady(bin, ["host", "--faux", "hi", "--data-dir", work, "--port", String(hostPort)]);
  const index = await get(hostPort);
  if (index.status !== 200 || !index.body.includes("<")) fail(`GET / on packaged host: ${index.status}`);
  await stop(host);

  const relayPort = await freePort();
  const relay = await untilReady(bin, [
    "relay",
    "--public-origin",
    `http://127.0.0.1:${relayPort}`,
    "--allow-host",
    hostId,
    "--port",
    String(relayPort),
  ]);
  const relayIndex = await get(relayPort);
  if (relayIndex.status !== 200 || !relayIndex.body.includes("<")) fail(`GET / on packaged relay: ${relayIndex.status}`);
  await stop(relay);

  console.log(`smoke ok: pinomad@${version} (version, relay-id, host+web, relay+web)`);
} finally {
  await rm(prefix, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
