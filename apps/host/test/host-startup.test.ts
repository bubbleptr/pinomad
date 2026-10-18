import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectRemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { relayHostId } from "@pinomad/protocol/relay.ts";
import { startRelay } from "@pinomad/server/src/relay.ts";
import { loadRelayKey } from "../src/devices.ts";
import { writeServerConfig } from "../src/server-config.ts";
import { freePort, openBoundAccounts, tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

it("keeps the host credential out of startup logs while local clients can connect", async () => {
  const data = await tempDir();
  defer(data.remove);
  const child = spawn(process.execPath, ["src/main.ts", "--faux", "ready", "--data-dir", data.path, "--port", "0"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  let ready: { url: string; tokenFile: string; web: string } | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    const event = JSON.parse(line);
    if (event.event === "ready") { ready = event; break; }
  }
  if (ready === undefined) throw new Error("host exited before ready");
  const token = (await readFile(join(data.path, "token"), "utf8")).trim();
  // A boolean assertion keeps the credential out of failed-test diagnostics too.
  expect(output.includes(token), "startup logs contain the host credential").toBe(false);
  expect(ready.tokenFile).toBe(join(data.path, "token"));
  expect(new URL(ready.web).hash).toBe("");
  const client = await connectRemoteDurable({ url: ready.url, token });
  defer(() => client.close());
  expect(client.view.current().connection).toBe("connected");
});

describe("server.json", () => {
  /** Spawns the host CLI and resolves with exit code and combined output. */
  function runHost(args: string[]): { child: ReturnType<typeof spawn>; output: () => string; exited: Promise<number> } {
    const child = spawn(process.execPath, ["src/main.ts", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    return { child, output: () => output, exited: once(child, "exit").then(([code]) => code as number) };
  }

  it("refuses to start when --relay disagrees with server.json", async () => {
    const data = await tempDir();
    defer(data.remove);
    await writeServerConfig(data.path, { origin: "https://a.example.com" });
    const { child, output, exited } = runHost([
      "--faux",
      "x",
      "--data-dir",
      data.path,
      "--port",
      "0",
      "--relay",
      "https://b.example.com",
    ]);
    defer(() => {
      child.kill("SIGKILL");
    });
    expect(await exited).not.toBe(0);
    expect(output()).toContain("disagrees");
    expect(output()).toContain("server.json");
  });

  it("dials the joined server from server.json without a --relay flag", async () => {
    const data = await tempDir();
    defer(data.remove);
    // The binding needs the hostId up front — create the key the host would.
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const hostId = relayHostId((await loadRelayKey(data.path)).publicKey);
    const server = await tempDir();
    defer(server.remove);
    const relay = await startRelay({ port, publicOrigin: origin, accounts: await openBoundAccounts(server.path, hostId) });
    defer(() => relay.close());
    await writeServerConfig(data.path, { origin });

    const { child, output, exited } = runHost(["--faux", "x", "--data-dir", data.path, "--port", "0"]);
    defer(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await exited;
    });
    // The relay log line proves the whole path: read config, dial, register.
    const deadline = Date.now() + 15_000;
    while (!output().includes('"event":"relay"') || !output().includes('"status":"registered"')) {
      if (Date.now() > deadline) throw new Error(`host never registered: ${output()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(output()).toContain(`"hostId":"${hostId}"`);
  });
});
