// Dedicated .local probe: Chromium advertises mDNS host candidates; Node's
// dns.lookup (getaddrinfo, same resolver libdatachannel uses) tries to resolve
// them while the browser is alive. Also runs the platform resolver CLI for
// cross-checking, so a failure cannot be blamed on one API.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const spikeDir = fileURLToPath(new URL("..", import.meta.url));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage();
await page.goto("data:text/html,<title>mdns</title>");
const gathered = await page.evaluate(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.createDataChannel("mdns-probe");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve(undefined);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") resolve(undefined);
    };
    setTimeout(resolve, 5000);
  });
  const sdp = pc.localDescription?.sdp ?? "";
  const candidates = sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:"));
  const names = [...new Set(candidates.map((line) => line.split(" ")[4]).filter((name) => name.endsWith(".local")))];
  return { candidates, names, sdpBytes: sdp.length };
});

const results = [];
for (const name of gathered.names) {
  const started = Date.now();
  let lookupResult;
  try {
    const addresses = await Promise.race([
      lookup(name, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lookup timeout")), 8000)),
    ]);
    lookupResult = { ok: true, addresses, durationMs: Date.now() - started };
  } catch (error) {
    lookupResult = { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
  }
  const cli: Record<string, unknown> = {};
  for (const [label, command, args] of [
    ["getent", "getent", ["hosts", name]],
    ["avahi-resolve", "avahi-resolve", ["-n", name]],
  ] as const) {
    try {
      const out = await execFileAsync(command, [...args], { timeout: 8000 });
      cli[label] = { ok: true, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
    } catch (error) {
      const failed = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      cli[label] = { ok: false, code: failed.code ?? null, stdout: failed.stdout?.trim() ?? "", stderr: failed.stderr?.trim() ?? "", message: failed.message ?? String(error) };
    }
  }
  results.push({ name, lookup: lookupResult, cli });
}

const evidence = {
  at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  chromium: browser.version(),
  sdpCandidates: gathered.candidates,
  names: gathered.names,
  results,
};
await mkdir(join(spikeDir, "evidence"), { recursive: true });
const path = join(spikeDir, "evidence", "mdns-" + process.platform + "-" + process.arch + ".json");
await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
