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

function noiseBridge(dc, pc) {
  log("data-channel", { label: dc.getLabel(), maxMessageSize: dc.maxMessageSize() });
  dc.setBufferedAmountLowThreshold(128 * 1024);
  const child = spawn(helperPath, [], {
    env: { ...process.env, RTC_SPIKE_SEED: String(seed) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let helperBuffer = Buffer.alloc(0);
  let dcQueue = [];
  let dcPumping = false;
  let dcWriteFalse = 0;
  let dcSent = 0;
  let dcTimer = null;
  let nextSendAt = 0;
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

  // libdatachannel 0.33.4 accepted a 4 MiB burst (observed past ~1 MiB) but
  // the receive side then failed on record #18. Pacing one record per 20 ms
  // is the spike's evidence-preserving workaround; production should drive
  // this from the host adapter's real buffer accounting.
  function pumpDc() {
    if (dcPumping || !open) return;
    if (!dc.isOpen()) {
      open = false;
      dcQueue = [];
      if (dcTimer) { clearTimeout(dcTimer); dcTimer = null; }
      log("dc-send-stopped", { reason: "channel not open" });
      return;
    }
    const now = Date.now();
    if (now < nextSendAt) {
      if (!dcTimer) dcTimer = setTimeout(() => { dcTimer = null; pumpDc(); }, nextSendAt - now);
      return;
    }
    dcPumping = true;
    let burst = 0;
    while (dcQueue.length > 0 && burst < 1) {
      const frame = dcQueue[0];
      let accepted;
      try {
        accepted = dc.sendMessageBinary(frame);
      } catch (error) {
        open = false;
        dcQueue = [];
        log("dc-send-stopped", { reason: String(error), queued: dcQueue.length });
        break;
      }
      if (!accepted) {
        dcWriteFalse += 1;
        break;
      }
      dcQueue.shift();
      dcSent += 1;
      burst += 1;
      nextSendAt = Date.now() + 20; // SEND_SPACING_MS keeps the native queue small
      log("dc-sent", { count: dcSent, bytes: frame.length, bufferedAmount: dc.bufferedAmount() });
    }
    dcPumping = false;
    if (dcQueue.length === 0) {
      log("dc-send-drained", { bufferedAmount: dc.bufferedAmount(), writeFalse: dcWriteFalse });
    } else if (!dcTimer) {
      dcTimer = setTimeout(() => { dcTimer = null; pumpDc(); }, 10);
    }
  }

  dc.onBufferedAmountLow(() => {
    log("dc-buffered-low", { bufferedAmount: dc.bufferedAmount(), queued: dcQueue.length });
    pumpDc();
  });

  dc.onOpen(() => {
    open = true;
    log("dc-open", { pair: selectedPair(pc), maxMessageSize: dc.maxMessageSize() });
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
    if (dcTimer) { clearTimeout(dcTimer); dcTimer = null; }
    log("dc-closed", { queued: dcQueue.length });
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
    log("noise-peer-exit", { code, signal, queued: dcQueue.length, writeFalse: dcWriteFalse });
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
      log("offer", { bytes: offer.length, remoteAddress: request.socket.remoteAddress });
      const pc = new ndc.PeerConnection(`answer-${sessionId}`, {
        iceServers: [],
        bindAddress,
        maxMessageSize: 262144,
      });
      attachPeer(pc, "answer");
      pc.onDataChannel((dc) => noiseBridge(dc, pc));
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
