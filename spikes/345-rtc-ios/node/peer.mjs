import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ndc from "node-datachannel";

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(here, "../target/debug/rtc-noise-peer");
const seed = Number(process.env.RTC_SPIKE_SEED ?? "7");
const port = Number(process.env.RTC_SPIKE_PORT ?? "8765");
const bindAddress = process.env.RTC_SPIKE_BIND ?? "0.0.0.0";
const sessionId = new Date().toISOString().replaceAll(":", "-");
let runCounter = 0;

function log(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForGathering(pc, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pc.gatheringState() === "complete") return;
    await delay(25);
  }
  throw new Error(`ICE gathering did not complete (${pc.gatheringState()})`);
}

function attachPeer(pc, label) {
  pc.onStateChange((state) => log("pc-state", { label, state }));
  pc.onIceStateChange((state) => log("ice-state", { label, state }));
  pc.onGatheringStateChange((state) => log("gathering-state", { label, state }));
  pc.onLocalCandidate((candidate, mid) => log("local-candidate", { label, mid, candidate }));
  pc.onLocalDescription((sdp, type) => log("local-description", { label, type, bytes: sdp.length }));
}

function selectedPair(pc) {
  const pair = pc.getSelectedCandidatePair();
  if (!pair) return null;
  return {
    local: { address: pair.local.address, port: pair.local.port, type: pair.local.type },
    remote: { address: pair.remote.address, port: pair.remote.port, type: pair.remote.type },
  };
}

function noiseBridge(dc, pc, runId) {
  log("data-channel", { runId, label: dc.getLabel(), maxMessageSize: dc.maxMessageSize() });
  dc.setBufferedAmountLowThreshold(64 * 1024);
  const child = spawn(helperPath, [], {
    env: { ...process.env, RTC_SPIKE_SEED: String(seed) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let helperBuffer = Buffer.alloc(0);
  let dcQueue = [];
  let dcPumping = false;
  let dcWriteFalse = 0;
  let dcSent = 0;
  let maxBuffered = 0;
  let maxQueue = 0;
  let helperInput = [];
  let helperWriting = false;
  let open = false;
  let pairLogged = false;

  function pumpHelperInput() {
    if (helperWriting) return;
    const next = helperInput.shift();
    if (!next) return;
    helperWriting = true;
    const accepted = child.stdin.write(next, () => {
      helperWriting = false;
      pumpHelperInput();
    });
    if (!accepted) {
      child.stdin.once("drain", () => {
        helperWriting = false;
        pumpHelperInput();
      });
    }
  }

  function sendToHelper(frame) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(frame.length, 0);
    helperInput.push(Buffer.concat([header, frame]));
    pumpHelperInput();
  }

  // node-datachannel 0.33.4 returns false after it has ALREADY enqueued the
  // message (libdatachannel SctpTransport::send pushes first and returns
  // false when it could not flush immediately). Retrying the same index would
  // duplicate a Noise record; consume the queue slot unconditionally.
  // Backpressure is driven only by bufferedAmount()/onBufferedAmountLow, with a
  // 50 ms fallback poll for a missed callback.
  const HIGH_WATER = 256 * 1024;
  // One Noise message2 plus 65 records for the fixed 4 MiB frame.
  const EXPECTED_ECHO = Number(process.env.RTC_SPIKE_EXPECTED_RECORDS ?? 65) + 1;
  let dcPollTimer = null;
  let runSummaryLogged = false;
  function summary(reason) {
    if (runSummaryLogged) return;
    runSummaryLogged = true;
    log("dc-run-summary", {
      runId,
      reason,
      sent: dcSent,
      writeFalse: dcWriteFalse,
      maxBuffered: maxBuffered,
      maxQueue: maxQueue,
    });
  }
  function schedulePoll() {
    if (dcPollTimer) return;
    dcPollTimer = setTimeout(() => { dcPollTimer = null; pumpDc(); }, 50);
  }
  function pumpDc() {
    if (dcPumping || !open) return;
    if (!dc.isOpen()) {
      open = false;
      dcQueue = [];
      if (dcPollTimer) { clearTimeout(dcPollTimer); dcPollTimer = null; }
      log("dc-send-stopped", { reason: "channel not open" });
      return;
    }
    dcPumping = true;
    while (dcQueue.length > 0 && dc.bufferedAmount() < HIGH_WATER) {
      const frame = dcQueue.shift();
      let accepted;
      try {
        accepted = dc.sendMessageBinary(frame);
      } catch (error) {
        open = false;
        dcQueue = [];
        log("dc-send-stopped", { reason: String(error), sent: dcSent, writeFalse: dcWriteFalse });
        break;
      }
      dcSent += 1;
      const buffered = dc.bufferedAmount();
      maxBuffered = Math.max(maxBuffered, buffered);
      maxQueue = Math.max(maxQueue, dcQueue.length + 1);
      if (!accepted) {
        dcWriteFalse += 1;
        // false means the record is in the native queue; do not retry it.
        break;
      }
    }
    dcPumping = false;
    if (dcQueue.length === 0) {
      if (dcSent >= EXPECTED_ECHO) {
        log("dc-send-drained", {
          sent: dcSent,
          writeFalse: dcWriteFalse,
          bufferedAmount: dc.bufferedAmount(),
          maxBuffered,
        });
        summary("drained");
      }
    } else {
      schedulePoll();
    }
  }

  dc.onBufferedAmountLow(() => {
    log("dc-buffered-low", { bufferedAmount: dc.bufferedAmount(), queued: dcQueue.length });
    pumpDc();
  });

  dc.onOpen(() => {
    open = true;
    log("dc-open", { pair: selectedPair(pc), maxMessageSize: dc.maxMessageSize(), highWater: HIGH_WATER, lowWater: 64 * 1024 });
    pumpDc();
    const timer = setInterval(() => {
      if (!open) { clearInterval(timer); return; }
      const pair = selectedPair(pc);
      if (pair && !pairLogged) {
        pairLogged = true;
        log("selected-pair", pair);
      }
    }, 250);
  });

  dc.onMessage((message) => {
    const frame = Buffer.isBuffer(message) ? message : Buffer.from(message);
    sendToHelper(frame);
  });

  dc.onClosed(() => {
    open = false;
    dcQueue = [];
    if (dcPollTimer) { clearTimeout(dcPollTimer); dcPollTimer = null; }
    summary("closed");
    log("dc-closed", { runId, queued: dcQueue.length, sent: dcSent, writeFalse: dcWriteFalse });
    child.kill("SIGTERM");
  });
  dc.onError((error) => log("dc-error", { error }));

  child.stdout.on("data", (chunk) => {
    helperBuffer = Buffer.concat([helperBuffer, chunk]);
    while (helperBuffer.length >= 4) {
      const length = helperBuffer.readUInt32LE(0);
      if (helperBuffer.length < 4 + length) break;
      const frame = helperBuffer.subarray(4, 4 + length);
      helperBuffer = helperBuffer.subarray(4 + length);
      dcQueue.push(Buffer.from(frame));
      maxQueue = Math.max(maxQueue, dcQueue.length);
      pumpDc();
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) log("noise-peer", { line: line.trim() });
    }
  });
  child.on("exit", (code, signal) => {
    open = false;
    log("noise-peer-exit", { runId, code, signal, queued: dcQueue.length, writeFalse: dcWriteFalse });
  });
  child.stdin.on("error", (error) => log("helper-stdin-error", { error: String(error) }));
  log("noise-peer-spawn", { helperPath, seed });
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/offer") {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    try {
      const offer = Buffer.concat(chunks).toString("utf8");
      runCounter += 1;
      const runId = `${Date.now()}-${runCounter}`;
      log("offer", { runId, bytes: offer.length, remoteAddress: request.socket.remoteAddress });
      const pc = new ndc.PeerConnection(`answer-${sessionId}-${runId}`, {
        iceServers: [],
        bindAddress,
        maxMessageSize: 262144,
      });
      attachPeer(pc, "answer");
      pc.onDataChannel((dc) => noiseBridge(dc, pc, runId));
      pc.setRemoteDescription(offer, "offer");
      await waitForGathering(pc);
      const answer = pc.localDescription();
      if (!answer) throw new Error("no local description after gathering");
      const candidates = answer.sdp.split("\n").filter((line) => line.startsWith("a=candidate:"));
      log("answer", { bytes: answer.sdp.length, candidates: candidates.length });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(answer.sdp);
      setTimeout(() => {
        log("answer-idle", { state: pc.state(), pair: selectedPair(pc) });
      }, 15000);
    } catch (error) {
      log("offer-error", { error: String(error), stack: error?.stack });
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(`error: ${error}`);
    }
  });
});

server.listen(port, bindAddress, () => {
  log("listening", { port, bindAddress, helperPath, seed, library: ndc.getLibraryVersion() });
});

function shutdown(signal) {
  log("shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
