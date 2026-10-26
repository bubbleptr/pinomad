// Shared runner for the #345 0a spike. Starts the relay, one node-datachannel
// peer (local or on mbp) and one Chromium (local Playwright or mbp Chrome via
// ssh + playwright-core), then collects both sides into evidence/<name>.json.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import { keyPairFromPrivate } from "../../../../packages/protocol/src/noise.ts";
import { toBase64Url } from "../../../../packages/protocol/src/secure-channel.ts";
import type { BrowserConfig, Mode, PeerConfig, SdpMaxMessageSize } from "../shared/types.ts";
import { startRelay, type RelayEvent } from "./relay.ts";

const spikeDir = fileURLToPath(new URL("../..", import.meta.url));
const remoteDir = "/tmp/pinomad-spike-345";
const remoteHost = "void@mbp";

export type HostTarget = "local" | "mbp";
export type BrowserTarget = "local" | "mbp";

export type RunOptions = {
  name: string;
  mode: Mode;
  host: HostTarget;
  browser: BrowserTarget;
  stun: string[];
  mdns: boolean;
  bindAddress?: string;
  sdpMaxMessageSize?: SdpMaxMessageSize;
  sizes?: number[];
  frameBytes?: number;
  frameSeed?: number;
  timeoutMs?: number;
  keepRemoteConfig?: boolean;
};

export type RunResult = {
  name: string;
  options: Omit<RunOptions, "keepRemoteConfig">;
  pageUrl: string;
  browser: Record<string, any> | null;
  host: { logs: Array<Record<string, any>>; stderr: string; exitCode: number | null; signal: string | null };
  relay: RelayEvent[];
  stderr: string;
};

const tailnetIpv4 = (): string | undefined => {
  const interfaces = networkInterfaces();
  const tailscale = interfaces.tailscale0 ?? interfaces.tailscale ?? [];
  return tailscale.find((entry) => entry.family === "IPv4")?.address;
};

async function waitExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function spawnLines(command: string, args: string[], options: { cwd?: string } = {}): {
  child: ChildProcess;
  lines: string[];
  stderr: string;
} {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, lines, stderr: "" };
}

async function runCommand(command: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr: stderr + "\n(timed out)" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + "\n" + error.message });
    });
  });
}

async function ensureRemoteFiles(options: { needPeer: boolean; needBrowser: boolean }): Promise<void> {
  const check = await runCommand("ssh", ["-o", "BatchMode=yes", remoteHost, `test -d ${remoteDir}/node_modules && test -f ${remoteDir}/node_modules/node-datachannel/package.json && test -f ${remoteDir}/node_modules/playwright-core/package.json`], 20_000);
  if (check.code !== 0) {
    throw new Error(`mbp is missing the spike deps in ${remoteDir}; run spikes/345-rtc-web/scripts/setup-mbp.sh first\n${check.stderr}`);
  }
  if (options.needPeer) {
    const copied = await runCommand("scp", ["-o", "BatchMode=yes", join(spikeDir, "dist/node-peer.mjs"), `${remoteHost}:${remoteDir}/node-peer.mjs`], 30_000);
    if (copied.code !== 0) throw new Error("scp node-peer.mjs to mbp failed: " + copied.stderr);
  }
  if (options.needBrowser) {
    const copied = await runCommand("scp", ["-o", "BatchMode=yes", join(spikeDir, "src/remote/browser.mjs"), `${remoteHost}:${remoteDir}/remote-browser.mjs`], 30_000);
    if (copied.code !== 0) throw new Error("scp remote-browser.mjs to mbp failed: " + copied.stderr);
  }
}

function browserArgs(mdns: boolean): string[] {
  return mdns ? [] : ["--disable-features=WebRtcHideLocalIpsWithMdns"];
}

export async function runSession(options: RunOptions): Promise<RunResult> {
  await mkdir(join(spikeDir, "evidence"), { recursive: true });
  await mkdir(join(spikeDir, ".tmp"), { recursive: true });
  const pagePath = join(spikeDir, "src/browser/page.html");
  const bundlePath = join(spikeDir, "dist/browser.js");
  const peerPath = join(spikeDir, "dist/node-peer.mjs");
  try {
    await readFile(bundlePath);
    await readFile(peerPath);
  } catch {
    throw new Error("dist/browser.js or dist/node-peer.mjs is missing; run `bun run build` in spikes/345-rtc-web");
  }

  const testId = options.name.replace(/[^a-z0-9-]/gi, "-") + "-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
  const token = randomBytes(12).toString("hex");
  const timeoutMs = options.timeoutMs ?? 150_000;
  const tailnet = tailnetIpv4();
  if ((options.host === "mbp" || options.browser === "mbp") && tailnet === undefined) {
    throw new Error("no tailscale0 IPv4 address; mbp runs need the tailnet");
  }
  if (options.host === "mbp") await ensureRemoteFiles({ needPeer: true, needBrowser: false });
  if (options.browser === "mbp") await ensureRemoteFiles({ needPeer: false, needBrowser: true });

  const hostKey = keyPairFromPrivate(randomBytes(32));
  const hostPrivateKey = toBase64Url(hostKey.privateKey);
  const hostPublicKey = toBase64Url(hostKey.publicKey);
  const relay = await startRelay({ token, pagePath, bundlePath });
  const browserHost = options.browser === "mbp" ? tailnet! : "127.0.0.1";
  const hostHost = options.host === "mbp" ? tailnet! : "127.0.0.1";
  const pageUrl = "http://" + browserHost + ":" + relay.port + "/";
  const browserWsUrl = "ws://" + browserHost + ":" + relay.port + "/ws?role=browser&token=" + token;
  const hostWsUrl = "ws://" + hostHost + ":" + relay.port + "/ws?role=host&token=" + token;

  const peerConfig: PeerConfig = {
    role: "host",
    wsUrl: hostWsUrl,
    mode: options.mode,
    stun: options.stun,
    hostPrivateKey,
    ...(options.bindAddress === undefined ? {} : { bindAddress: options.bindAddress }),
    ...(options.sdpMaxMessageSize === undefined ? {} : { sdpMaxMessageSize: options.sdpMaxMessageSize }),
    ...(options.sizes === undefined ? {} : { sizes: options.sizes }),
    ...(options.frameBytes === undefined ? {} : { frameBytes: options.frameBytes }),
    ...(options.frameSeed === undefined ? {} : { frameSeed: options.frameSeed }),
    testId,
  };
  const browserConfig: BrowserConfig = {
    wsUrl: browserWsUrl,
    mode: options.mode,
    stun: options.stun,
    hostPublicKey,
    ...(options.sizes === undefined ? {} : { sizes: options.sizes }),
    ...(options.frameBytes === undefined ? {} : { frameBytes: options.frameBytes }),
    ...(options.frameSeed === undefined ? {} : { frameSeed: options.frameSeed }),
    testId,
  };

  const localConfigPath = join(spikeDir, ".tmp", testId + ".host.json");
  await writeFile(localConfigPath, JSON.stringify(peerConfig, null, 2));
  let remoteConfigName: string | undefined;
  if (options.host === "mbp") {
    remoteConfigName = testId + ".host.json";
    const scp = await runCommand("scp", ["-o", "BatchMode=yes", localConfigPath, `${remoteHost}:${remoteDir}/${remoteConfigName}`], 30_000);
    if (scp.code !== 0) throw new Error("scp host config to mbp failed: " + scp.stderr);
  }

  const hostProcess = options.host === "local"
    ? spawnLines(process.execPath, [peerPath, localConfigPath], { cwd: spikeDir })
    : spawnLines("ssh", ["-o", "BatchMode=yes", remoteHost, `cd ${remoteDir} && exec /opt/homebrew/bin/node node-peer.mjs ${remoteConfigName}`]);
  let hostStderr = "";
  hostProcess.child.stderr?.on("data", (chunk: Buffer) => {
    hostStderr += chunk.toString();
  });
  let hostExitCode: number | null = null;
  let hostSignal: NodeJS.Signals | null = null;
  hostProcess.child.once("exit", (code, signal) => {
    hostExitCode = code;
    hostSignal = signal;
  });

  let browserResult: Record<string, any> | null = null;
  let browserProcess: ChildProcess | undefined;
  let browserStderr = "";
  let localBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserReady: Promise<Record<string, any>> | undefined;
  let remoteBrowserConfigName: string | undefined;
  let earlyBrowserError: string | undefined;
  let failure: Error | undefined;
  try {
    const hostFailed = new Promise<never>((_, reject) => {
      hostProcess.child.once("exit", (code, signal) => {
        if (code !== 0) {
          reject(new Error("host peer exited before pairing: code=" + code + " signal=" + signal + "\n" + hostProcess.lines.join("\n") + "\n" + hostStderr));
        }
      });
    });

    if (options.browser === "local") {
      localBrowser = await chromium.launch({ channel: "chromium", headless: true, args: browserArgs(options.mdns) });
      const page = await localBrowser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
        earlyBrowserError = error.message;
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          pageErrors.push(message.text());
          earlyBrowserError = message.text();
        }
      });
      await page.addInitScript((config: BrowserConfig) => {
        (window as unknown as { __SPIKE_CONFIG: BrowserConfig }).__SPIKE_CONFIG = config;
      }, browserConfig);
      browserReady = (async () => {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForFunction(() => (window as unknown as { __SPIKE?: { done?: boolean } }).__SPIKE?.done === true, undefined, { timeout: timeoutMs });
        const result = (await page.evaluate(() => (window as unknown as { __SPIKE: Record<string, any> }).__SPIKE)) as Record<string, any>;
        if (pageErrors.length > 0) result.pageErrors = pageErrors;
        return result;
      })();
    } else {
      remoteBrowserConfigName = testId + ".browser.json";
      const remoteBrowserConfig = {
        pageUrl,
        mdns: options.mdns,
        timeoutMs,
        browser: browserConfig,
      };
      const localBrowserConfigPath = join(spikeDir, ".tmp", remoteBrowserConfigName);
      await writeFile(localBrowserConfigPath, JSON.stringify(remoteBrowserConfig, null, 2));
      const scpConfig = await runCommand("scp", ["-o", "BatchMode=yes", localBrowserConfigPath, `${remoteHost}:${remoteDir}/${remoteBrowserConfigName}`], 30_000);
      if (scpConfig.code !== 0) throw new Error("scp browser config to mbp failed: " + scpConfig.stderr);
      const proc = spawn("ssh", ["-o", "BatchMode=yes", remoteHost, `cd ${remoteDir} && exec /opt/homebrew/bin/node remote-browser.mjs ${remoteBrowserConfigName}`], { stdio: ["ignore", "pipe", "pipe"] });
      browserProcess = proc;
      let remoteOut = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        remoteOut += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        browserStderr += text;
        if (text.includes("PAGE_ERROR") || text.includes("PAGE_CONSOLE_ERROR") || text.includes("REMOTE_BROWSER_ERROR")) earlyBrowserError = text.trim();
      });
      browserReady = (async () => {
        const exit = await waitExit(proc, timeoutMs + 30_000);
        const marker = "REMOTE_BROWSER_RESULT ";
        const line = remoteOut.split("\n").find((entry) => entry.startsWith(marker));
        if (line === undefined) {
          throw new Error("remote browser produced no result (exit " + exit.code + "):\n" + remoteOut + "\n" + browserStderr);
        }
        return JSON.parse(line.slice(marker.length)) as Record<string, any>;
      })();
    }

    const browserFailed = browserReady.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => {
        throw new Error("browser failed: " + (error instanceof Error ? error.message : String(error)));
      },
    );
    try {
      await Promise.race([relay.waitForBoth(45_000), hostFailed, browserFailed]);
    } catch (error) {
      throw new Error((error instanceof Error ? error.message : String(error)) + (earlyBrowserError === undefined ? "" : "\npage error: " + earlyBrowserError));
    }
    browserResult = await browserReady;
    // Keep the browser alive until the host peer has logged its late .local
    // candidates; the finally block closes it.
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    browserReady?.catch(() => {});
    if (localBrowser !== undefined) await localBrowser.close().catch(() => {});
    if (browserProcess !== undefined) {
      browserProcess.kill("SIGTERM");
      await waitExit(browserProcess, 10_000).catch(() => {});
    }
    await waitExit(hostProcess.child, 10_000).catch(() => {});
    if (hostProcess.child.exitCode === null) hostProcess.child.kill("SIGKILL");
    await relay.close();
    if (options.host === "mbp") {
      await runCommand("ssh", ["-o", "BatchMode=yes", remoteHost, `pkill -f 'node-peer.mjs ${remoteConfigName}' || true; rm -f ${remoteDir}/${remoteConfigName}`], 20_000);
    }
    if (remoteBrowserConfigName !== undefined) {
      await runCommand("ssh", ["-o", "BatchMode=yes", remoteHost, `rm -f ${remoteDir}/${remoteBrowserConfigName}`], 20_000);
    }
    await rm(localConfigPath, { force: true });
  }

  const hostLogs: Array<Record<string, any>> = [];
  for (const line of hostProcess.lines) {
    if (!line.startsWith("{")) continue;
    try {
      hostLogs.push(JSON.parse(line) as Record<string, any>);
    } catch {
      // A truncated line from a killed peer; keep the rest.
    }
  }
  if (failure !== undefined) {
    const failurePath = join(spikeDir, "evidence", options.name + ".failed.json");
    await writeFile(
      failurePath,
      JSON.stringify(
        {
          name: options.name,
          options,
          error: failure.message,
          stack: failure.stack,
          browser: browserResult,
          host: { logs: hostLogs, stderr: hostStderr, exitCode: hostExitCode, signal: hostSignal },
          relay: relay.events,
          stderr: browserStderr,
        },
        null,
        2,
      ) + "\n",
    );
    console.error("evidence (failed):", failurePath);
    throw failure;
  }
  const result: RunResult = {
    name: options.name,
    options: {
      name: options.name,
      mode: options.mode,
      host: options.host,
      browser: options.browser,
      stun: options.stun,
      mdns: options.mdns,
      ...(options.bindAddress === undefined ? {} : { bindAddress: options.bindAddress }),
      ...(options.sdpMaxMessageSize === undefined ? {} : { sdpMaxMessageSize: options.sdpMaxMessageSize }),
      ...(options.sizes === undefined ? {} : { sizes: options.sizes }),
      ...(options.frameBytes === undefined ? {} : { frameBytes: options.frameBytes }),
      ...(options.frameSeed === undefined ? {} : { frameSeed: options.frameSeed }),
    },
    pageUrl: pageUrl.replace(/token=[^&]+/g, "token=<redacted>"),
    browser: browserResult,
    host: {
      logs: hostLogs,
      stderr: hostStderr,
      exitCode: hostExitCode,
      signal: hostSignal,
    },
    relay: relay.events,
    stderr: browserStderr,
  };
  const evidencePath = join(spikeDir, "evidence", options.name + ".json");
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n");
  console.log("evidence:", evidencePath);
  return result;
}

/** Small human summary for the console; the JSON stays authoritative. */
export function summarize(result: RunResult): Record<string, unknown> {
  const browserSelected = result.browser?.stats?.selectedPair ?? null;
  const browserLocal = result.browser?.stats?.localCandidate ?? null;
  const browserRemote = result.browser?.stats?.remoteCandidate ?? null;
  const hostSelected = [...result.host.logs].reverse().find((entry) => entry.event === "selected-pair" || entry.event === "finish") ?? null;
  const mdns = result.host.logs.filter((entry) => entry.event === "mdns-resolution");
  return {
    name: result.name,
    browserMaxMessageSize: result.browser?.maxMessageSize ?? null,
    browserSelectedPair: browserSelected,
    browserLocalCandidate: browserLocal,
    browserRemoteCandidate: browserRemote,
    hostSelected: hostSelected?.selectedPair ?? null,
    hostSelectedLog: hostSelected,
    mdns,
  };
}
