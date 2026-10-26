// The real WebRTC path, in a normal Node process: vitest's worker pool does
// not deliver node-datachannel's native thread callbacks, so the host and the
// offerer both run as child processes here. The assertions are the child's
// JSON verdict; nothing about ICE or Noise is faked.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import { stopChild, tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();
const hostDir = fileURLToPath(new URL("..", import.meta.url));

interface Verdict {
  readonly ok: boolean;
  readonly error?: string;
  readonly protocolMinor?: number;
  readonly businessMinor?: number;
  readonly ping?: string;
  readonly afterSignal?: string;
  readonly largeBytes?: number;
  readonly largeMatch?: boolean;
  readonly revokedSignalCode?: number;
  readonly businessCode?: number;
  readonly completedPeersClosed?: boolean;
}

function startHost(dataDir: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["src/main.ts", "--data-dir", dataDir, "--port", "0", "--faux", "rtc answer"],
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
      [join(hostDir, "test/fixtures/rtc-client.ts"), url, token],
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

describe("host RTC over real libdatachannel", () => {
  it("answers business and signal offers, hands the DC over, and round-trips a multi-MiB frame", async () => {
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
    expect(last!.protocolMinor).toBe(PROTOCOL.minor);
    expect(last!.businessMinor).toBe(PROTOCOL.minor);
    expect(last!.ping).toBe("dc-ping");
    expect(last!.afterSignal).toBe("after-signal");
    expect(last!.largeBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(last!.largeMatch).toBe(true);
    expect(last!.revokedSignalCode).toBe(4401);
    expect(last!.businessCode).toBe(4401);
    expect(last!.completedPeersClosed).toBe(true);
  }, 180_000);
});
