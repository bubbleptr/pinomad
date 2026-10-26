// End-to-end coordinator upgrade over real libdatachannel: a real host, a
// real WebSocket business connection, a real DataChannel handoff, a real
// business call and stream after the switch, then a DataChannel close and a
// WebSocket reconnect. The coordinator and the native peer run in a plain
// Node child because vitest workers do not receive node-datachannel's native
// thread callbacks.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stopChild, tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();
const hostDir = fileURLToPath(new URL("..", import.meta.url));

interface Verdict {
  readonly ok: boolean;
  readonly error?: string;
  readonly models?: number;
  readonly pairingUrl?: boolean;
  readonly selectedCandidateType?: string | null;
  readonly fallbackPath?: string;
  readonly connection?: string;
}

function startHost(dataDir: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["src/main.ts", "--data-dir", dataDir, "--port", "0", "--faux", "rtc coordinator"],
      { cwd: hostDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`host exited ${code} before ready: ${stderr}`)));
    const lines = createInterface({ input: child.stdout! });
    void (async () => {
      for await (const line of lines) {
        let frame: { event?: string; url?: string };
        try {
          frame = JSON.parse(line) as { event?: string; url?: string };
        } catch {
          continue;
        }
        if (frame.event === "ready" && frame.url !== undefined) {
          resolve({ child, url: frame.url });
          return;
        }
      }
      reject(new Error(`host produced no ready line: ${stderr}`));
    })();
  });
}

function runClient(url: string, token: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(hostDir, "test/fixtures/rtc-coordinator-client.ts"), url, token],
      { cwd: hostDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    defer(() => stopChild(child));
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("coordinator RTC upgrade over real libdatachannel", () => {
  it("upgrades from WebSocket to P2P, keeps calls and streams working, and falls back when the DC closes", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await writeFile(join(dir.path, "settings.json"), `${JSON.stringify({ rtcStun: [] })}\n`);

    const host = await startHost(dir.path);
    defer(() => stopChild(host.child));
    const token = (await readFile(join(dir.path, "token"), "utf8")).trim();
    const result = await runClient(host.url, token);
    const verdicts = result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Verdict;
        } catch {
          return undefined;
        }
      })
      .filter((verdict): verdict is Verdict => verdict !== undefined);
    const last = verdicts.at(-1);
    expect(last, `no client verdict\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBeDefined();
    expect(
      last!.ok,
      `client failed: ${last!.error ?? "unknown"}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(true);
    expect(result.code, result.stderr).toBe(0);
    expect(last!.connection).toBe("connected");
    expect(last!.fallbackPath).not.toBe("p2p");
    expect(last!.pairingUrl).toBe(true);
    expect(last!.models).not.toBeUndefined();
  }, 180_000);
});
