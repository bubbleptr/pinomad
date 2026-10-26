// Browser side of the #345 0a spike. Runs in Chromium (Playwright) and speaks
// the same Noise IK + record layer as the product over a reliable, ordered
// DataChannel. No product code is changed; SecureSession/noise are imported
// straight from packages/protocol.

import { generateKeyPair, initiateIK } from "../../../../packages/protocol/src/noise.ts";
import {
  SECURE_PROLOGUE,
  SecureSession,
  decodeHostHello,
  encodeClientHello,
  fromBase64Url,
} from "../../../../packages/protocol/src/secure-channel.ts";
import {
  makeFrame,
  matchesBytePattern,
  recordStats,
  sha256Hex,
  utf8Length,
} from "../shared/frame.ts";
import { parseCandidate, type BrowserConfig } from "../shared/types.ts";

const config = (window as unknown as { __SPIKE_CONFIG: BrowserConfig }).__SPIKE_CONFIG;
const state: Record<string, any> = {
  startedAt: Date.now(),
  config: { ...config, wsUrl: config.wsUrl.replace(/token=[^&]+/, "token=<redacted>") },
  done: false,
  result: null,
  log: [],
  errors: [],
  localCandidates: [],
  remoteCandidates: [],
  localSdp: null,
  remoteSdp: null,
  stats: null,
  maxMessageSize: null,
  sizeResults: [],
  receivedSizes: [],
  noise: null,
};
(window as unknown as { __SPIKE: typeof state }).__SPIKE = state;

function log(event: string, data: Record<string, unknown> = {}): void {
  const entry = { t: Date.now(), event, ...data };
  state.log.push(entry);
  console.log("[spike] " + JSON.stringify(entry));
}

function redact(text: string): string {
  return text.replace(/token=[^&]+/g, "token=<redacted>");
}

function fail(message: string, data: Record<string, unknown> = {}): void {
  if (state.done) return;
  state.errors.push({ message, ...data });
  log("fail", { message, ...data });
  state.result = { ...summary(), error: message };
  state.done = true;
  closeTransport();
}

function finish(extra: Record<string, unknown> = {}): void {
  if (state.done) return;
  state.result = { ...summary(), ...extra };
  state.done = true;
  log("done", {});
  // In connect mode the host still needs a moment to log its .local DNS result;
  // keep the channel open long enough for that evidence to land.
  setTimeout(closeTransport, config.mode === "connect" ? 30_000 : 100);
}

function closeTransport(): void {
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
}

function summary(): Record<string, unknown> {
  return {
    side: "browser",
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    config: state.config,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    localCandidates: state.localCandidates,
    remoteCandidates: state.remoteCandidates,
    localSdp: state.localSdp,
    remoteSdp: state.remoteSdp,
    maxMessageSize: state.maxMessageSize,
    stats: state.stats,
    sizeResults: state.sizeResults,
    receivedSizes: state.receivedSizes,
    noise: state.noise,
    errors: state.errors,
    log: state.log,
  };
}

const pc = new RTCPeerConnection({ iceServers: config.stun.map((url) => ({ urls: url })) });
const dc = pc.createDataChannel("spike-345", { ordered: true });
dc.binaryType = "arraybuffer";

let remoteDescriptionSet = false;
const queuedCandidates: Array<{ candidate: string; mid: string | null }> = [];
let statsScheduled = false;
let iceGatheringTimer: ReturnType<typeof setTimeout> | undefined;

log("pc-created", { stun: config.stun, mode: config.mode });
state.localDescriptionAt = null;

function sdpSummary(sdp: string | null | undefined): Record<string, unknown> | null {
  if (sdp === null || sdp === undefined) return null;
  const lines = sdp.split(/\r?\n/);
  return {
    bytes: sdp.length,
    maxMessageSize: lines.filter((line) => line.startsWith("a=max-message-size:")),
    candidates: lines.filter((line) => line.startsWith("a=candidate:")).map(parseCandidate),
    full: sdp,
  };
}

function readMaxMessageSize(): number | null {
  try {
    const value = (pc as unknown as { sctp?: { maxMessageSize?: number } }).sctp?.maxMessageSize;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function captureSdp(kind: "local" | "remote"): void {
  const sdp = kind === "local" ? pc.localDescription?.sdp : pc.remoteDescription?.sdp;
  if (kind === "local") state.localSdp = sdpSummary(sdp);
  else state.remoteSdp = sdpSummary(sdp);
  const summary = kind === "local" ? state.localSdp : state.remoteSdp;
  log(kind + "-sdp", {
    bytes: summary?.bytes ?? null,
    maxMessageSize: summary?.maxMessageSize ?? null,
    candidates: summary?.candidates ?? null,
  });
}

pc.onicecandidate = (event) => {
  if (event.candidate === null) {
    log("ice-gathering-complete");
    captureSdp("local");
    return;
  }
  const info = parseCandidate(event.candidate.candidate);
  state.localCandidates.push(info);
  log("local-candidate", info);
  sendSignal({ type: "candidate", candidate: event.candidate.candidate, mid: event.candidate.sdpMid });
};

pc.onicecandidateerror = (event) => {
  log("ice-candidate-error", { errorCode: event.errorCode, errorText: event.errorText, url: event.url });
};

pc.onicegatheringstatechange = () => {
  log("ice-gathering-state", { state: pc.iceGatheringState });
  if (pc.iceGatheringState === "complete") captureSdp("local");
};

pc.onconnectionstatechange = () => {
  log("pc-connection-state", { state: pc.connectionState });
  if (pc.connectionState === "connected" || pc.connectionState === "failed") scheduleStats(1000);
};

pc.oniceconnectionstatechange = () => {
  log("pc-ice-state", { state: pc.iceConnectionState });
  if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") scheduleStats(1000);
};

dc.onopen = () => {
  state.dcOpenAt = Date.now();
  log("dc-open", { maxMessageSize: readMaxMessageSize() });
  void onTransportOpen();
};

dc.onclose = () => {
  log("dc-close", { done: state.done, completing: state.completing === true });
  if (!state.done && state.completing !== true) fail("DataChannel closed before the test completed");
};

dc.onerror = (event) => {
  const error = event as unknown as { error?: { message?: string } };
  log("dc-error", { message: error.error?.message ?? String(event) });
};

dc.onmessage = (event) => {
  void onTransportMessage(event.data);
};

const ws = new WebSocket(config.wsUrl);
const signalQueue: string[] = [];
let wsOpen = false;
ws.onopen = () => {
  wsOpen = true;
  log("ws-open");
  for (const message of signalQueue.splice(0)) ws.send(message);
};
ws.onerror = () => log("ws-error");
ws.onclose = (event) => log("ws-close", { code: event.code, reason: event.reason });
ws.onmessage = (event) => {
  let message: Record<string, any>;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    log("signal-bad-json");
    return;
  }
  state.lastSignal = message.type;
  void handleSignal(message);
};

function sendSignal(message: Record<string, unknown>): void {
  const text = JSON.stringify(message);
  if (wsOpen) ws.send(text);
  else signalQueue.push(text);
}

async function handleSignal(message: Record<string, any>): Promise<void> {
  try {
    if (message.type === "answer") {
      state.remoteSdp = sdpSummary(String(message.sdp));
      log("answer-received", {
        maxMessageSize: state.remoteSdp?.maxMessageSize ?? null,
        candidates: state.remoteSdp?.candidates ?? null,
      });
      await pc.setRemoteDescription({ type: "answer", sdp: String(message.sdp) });
      remoteDescriptionSet = true;
      state.maxMessageSize = readMaxMessageSize();
      log("answer-applied", { maxMessageSize: state.maxMessageSize });
      captureSdp("remote");
      for (const candidate of queuedCandidates.splice(0)) await addRemoteCandidate(candidate);
    } else if (message.type === "candidate") {
      const candidate = { candidate: String(message.candidate), mid: message.mid === null ? null : String(message.mid) };
      state.remoteCandidates.push(parseCandidate(candidate.candidate));
      log("remote-candidate", parseCandidate(candidate.candidate));
      if (remoteDescriptionSet) await addRemoteCandidate(candidate);
      else queuedCandidates.push(candidate);
    }
  } catch (error) {
    fail("signaling failed: " + errorMessage(error));
  }
}

async function addRemoteCandidate(candidate: { candidate: string; mid: string | null }): Promise<void> {
  try {
    await pc.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.mid ?? undefined });
  } catch (error) {
    log("add-ice-candidate-error", { message: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function start(): Promise<void> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  captureSdp("local");
  iceGatheringTimer = setTimeout(() => captureSdp("local"), 2500);
  sendSignal({ type: "offer", sdp: pc.localDescription?.sdp ?? "" });
  log("offer-sent", { bytes: pc.localDescription?.sdp.length ?? 0 });
}

function sendText(message: Record<string, unknown>): void {
  dc.send(JSON.stringify(message));
}

async function onTransportOpen(): Promise<void> {
  if (config.mode === "connect") {
    sendText({ type: "hello", testId: config.testId, at: Date.now() });
    return;
  }
  if (config.mode === "noise") {
    const device = generateKeyPair();
    const handshake = initiateIK({
      prologue: SECURE_PROLOGUE,
      static: device,
      remoteStatic: fromBase64Url(config.hostPublicKey),
    });
    const message1 = handshake.writeMessage1(encodeClientHello({ v: 1 }));
    state.noise = {
      phase: "handshake",
      handshake,
      handshakeStartedAt: Date.now(),
      inboundRecords: 0,
      outboundDone: false,
      verdictSent: false,
    };
    dc.send(message1);
    log("noise-message1-sent", { bytes: message1.byteLength });
    return;
  }
  if (config.mode === "maxmsg") {
    sendText({ type: "maxmsg-ready", testId: config.testId, maxMessageSize: readMaxMessageSize() });
    log("maxmsg-ready", { maxMessageSize: readMaxMessageSize() });
  }
}

async function onTransportMessage(data: unknown): Promise<void> {
  if (config.mode === "connect") {
    if (typeof data === "string") {
      const message = JSON.parse(data) as Record<string, any>;
      log("dc-message", message);
      if (message.type === "hello-ack") {
        // Take an early snapshot (the pair may be prflx) and a late one (after
        // libdatachannel's ~5s getaddrinfo for .local has had time to land).
        setTimeout(() => { void collectStats(); }, 800);
        setTimeout(() => {
          state.completing = true;
          void collectStats().then(() => finish());
        }, 8300);
      }
    }
    return;
  }
  if (config.mode === "maxmsg") {
    if (typeof data === "string") {
      const message = JSON.parse(data) as Record<string, any>;
      log("maxmsg-control", message);
      if (message.type === "size-start") {
        state.pendingSize = message.size;
      } else if (message.type === "size-result") {
        state.sizeResults.push(message);
        state.pendingSize = undefined;
        if (message.ok !== true) state.stoppedAt = message.size;
      } else if (message.type === "done") {
        state.completing = true;
        setTimeout(() => { void collectStats().then(() => finish()); }, 200);
      }
      return;
    }
    const bytes = toBytes(data);
    const size = bytes.length;
    const patternOk = matchesBytePattern(bytes);
    const digest = sha256Hex(bytes);
    state.receivedSizes.push({ size, patternOk, sha256: digest, at: Date.now() });
    log("maxmsg-binary-received", { size, patternOk, sha256: digest });
    // Small control text first: it tells the host the h2b direction worked even
    // when the echo cannot be sent because of the browser's send limit.
    try {
      sendText({ type: "size-received", size, patternOk, sha256: digest });
    } catch (error) {
      log("maxmsg-received-send-failed", { size, error: errorMessage(error) });
    }
    if (state.echoBroken === true) {
      try { sendText({ type: "size-skip", size, reason: "browser send limit already exceeded" }); } catch {}
      log("maxmsg-echo-skipped", { size });
      return;
    }
    try {
      dc.send(bytes);
      log("maxmsg-echo-sent", { size });
    } catch (error) {
      state.echoBroken = true;
      const message = { type: "size-error", size, error: errorMessage(error) };
      log("maxmsg-echo-failed", { size, error: errorMessage(error) });
      try { sendText(message); } catch {}
    }
    return;
  }
  if (config.mode === "noise") {
    await onNoiseMessage(data);
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("unexpected DataChannel payload type: " + typeof data);
}

async function onNoiseMessage(data: unknown): Promise<void> {
  const noise = state.noise;
  if (noise === null || noise === undefined) {
    fail("noise message before handshake state");
    return;
  }
  const bytes = toBytes(data);
  if (noise.session === undefined) {
    try {
      const opened = noise.handshake.readMessage2(bytes);
      decodeHostHello(opened.payload);
      noise.session = new SecureSession(opened.result);
      noise.phase = "encrypted";
      noise.handshakeDoneAt = Date.now();
      log("noise-handshake-done", { bytes: bytes.byteLength });
      void startNoiseOutbound();
    } catch (error) {
      fail("noise handshake failed: " + errorMessage(error));
    }
    return;
  }
  try {
    const text = noise.session.open(bytes);
    noise.inboundRecords += 1;
    noise.inboundCiphertextBytes = (noise.inboundCiphertextBytes ?? 0) + bytes.byteLength;
    if (text === undefined) return;
    if (noise.hostFrame === undefined) {
      const expected = makeFrame(config.frameSeed ?? 345, config.frameBytes ?? 8 * 1024 * 1024);
      const match = text === expected;
      noise.hostFrame = {
        plaintextBytes: utf8Length(text),
        sha256: sha256Hex(new TextEncoder().encode(text)),
        expectedSha256: sha256Hex(new TextEncoder().encode(expected)),
        match,
        records: noise.inboundRecords,
        ciphertextBytes: noise.inboundCiphertextBytes,
        receivedAt: Date.now(),
      };
      noise.phase = "host-frame-received";
      log("noise-host-frame-received", { ...noise.hostFrame });
      const verdict = {
        type: "spike-verdict",
        direction: "h2b",
        ok: match,
        plaintextBytes: noise.hostFrame.plaintextBytes,
        sha256: noise.hostFrame.sha256,
        records: noise.hostFrame.records,
      };
      noise.verdictPending = verdict;
      noise.inboundRecords = 0;
      noise.inboundCiphertextBytes = 0;
      sendPendingVerdict();
      void maybeFinishNoise();
      return;
    }
    if (noise.hostVerdict === undefined) {
      noise.hostVerdict = JSON.parse(text) as Record<string, any>;
      noise.phase = "host-verdict-received";
      log("noise-host-verdict", noise.hostVerdict);
      void maybeFinishNoise();
      return;
    }
    log("noise-unexpected-frame", { bytes: text.length });
  } catch (error) {
    fail("noise record open failed: " + errorMessage(error));
  }
}

async function startNoiseOutbound(): Promise<void> {
  const noise = state.noise;
  const session = noise?.session;
  if (session === undefined) return;
  try {
    const frame = makeFrame(config.frameSeed ?? 345, config.frameBytes ?? 8 * 1024 * 1024);
    const records = session.seal(frame);
    noise.frame = {
      plaintextBytes: utf8Length(frame),
      sha256: sha256Hex(new TextEncoder().encode(frame)),
      records: recordStats(records, utf8Length(frame)),
      sealedAt: Date.now(),
    };
    log("noise-frame-sealed", { ...noise.frame });
    noise.pump = await pumpRecords(dc, records);
    noise.outboundDone = true;
    noise.phase = "outbound-done";
    log("noise-outbound-done", { ...noise.pump });
    sendPendingVerdict();
    void maybeFinishNoise();
  } catch (error) {
    fail("noise outbound pump failed: " + errorMessage(error));
  }
}

function sendPendingVerdict(): void {
  const noise = state.noise;
  if (noise === undefined || noise.verdictSent) return;
  if (noise.outboundDone !== true || noise.verdictPending === undefined) return;
  try {
    const records = noise.session.seal(JSON.stringify(noise.verdictPending));
    for (const record of records) dc.send(record);
    noise.verdictSent = true;
    noise.verdictedAt = Date.now();
    log("noise-verdict-sent", { records: records.length, verdict: noise.verdictPending });
  } catch (error) {
    fail("noise verdict send failed: " + errorMessage(error));
  }
}

async function maybeFinishNoise(): Promise<void> {
  const noise = state.noise;
  if (noise === undefined || state.done) return;
  if (noise.outboundDone !== true) return;
  if (noise.hostFrame === undefined) return;
  if (noise.hostVerdict === undefined) return;
  if (noise.verdictSent !== true) return;
  if (noise.finished) return;
  noise.finished = true;
  state.completing = true;
  await collectStats();
  finish();
}

type PumpMetrics = {
  records: number;
  sent: number;
  highWater: number;
  lowWater: number;
  maxBuffered: number;
  lowEvents: number;
  failedSends: number;
  durationMs: number;
};

function pumpRecords(channel: RTCDataChannel, records: Uint8Array[]): Promise<PumpMetrics> {
  const highWater = 256 * 1024;
  const lowWater = 64 * 1024;
  const timeoutMs = 60_000;
  channel.bufferedAmountLowThreshold = lowWater;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let index = 0;
    let maxBuffered = 0;
    let lowEvents = 0;
    let failedSends = 0;
    let scheduled = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      channel.onbufferedamountlow = null;
      if (timer !== undefined) clearTimeout(timer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    };
    const fail = (error: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const tick = (delayMs = 0): void => {
      if (scheduled || finished) return;
      scheduled = true;
      if (delayMs > 0) {
        pollTimer = setTimeout(() => {
          pollTimer = undefined;
          scheduled = false;
          run();
        }, delayMs);
        return;
      }
      queueMicrotask(() => {
        scheduled = false;
        run();
      });
    };
    const run = (): void => {
      if (finished) return;
      let buffered = channel.bufferedAmount;
      try {
        while (index < records.length) {
          buffered = channel.bufferedAmount;
          if (buffered > maxBuffered) maxBuffered = buffered;
          if (buffered >= highWater) break;
          channel.send(records[index]!);
          index += 1;
        }
      } catch (error) {
        fail(error);
        return;
      }
      if (index >= records.length) {
        finished = true;
        cleanup();
        resolve({
          records: records.length,
          sent: index,
          highWater,
          lowWater,
          maxBuffered,
          lowEvents,
          failedSends,
          durationMs: Math.round(performance.now() - started),
        });
        return;
      }
      // onbufferedamountlow is the primary wake-up; the short poll only covers
      // a missed callback and never resends a record.
      tick(buffered >= highWater ? 50 : 0);
    };
    channel.onbufferedamountlow = () => {
      lowEvents += 1;
      log("buffered-amount-low", {
        bufferedAmount: channel.bufferedAmount,
        sent: index,
        records: records.length,
      });
      tick();
    };
    timer = setTimeout(() => fail("pump made no progress within " + timeoutMs + "ms"), timeoutMs);
    log("pump-start", {
      records: records.length,
      highWater,
      lowWater,
      bufferedAmount: channel.bufferedAmount,
    });
    run();
  });
}

function scheduleStats(delayMs: number): void {
  if (statsScheduled) return;
  statsScheduled = true;
  setTimeout(() => {
    statsScheduled = false;
    void collectStats();
  }, delayMs);
}

async function collectStats(): Promise<void> {
  try {
    const reports = await pc.getStats();
    const byId = new Map<string, any>();
    reports.forEach((report) => byId.set(report.id, report));
    const candidateStats: Array<Record<string, unknown>> = [];
    let transport: Record<string, any> | undefined;
    let selectedPair: Record<string, any> | undefined;
    reports.forEach((report) => {
      if (report.type === "local-candidate" || report.type === "remote-candidate") {
        candidateStats.push(pickCandidate(report));
      }
      if (report.type === "transport") transport = report;
    });
    const pairId = transport?.selectedCandidatePairId;
    if (pairId !== undefined) selectedPair = byId.get(pairId);
    if (selectedPair === undefined) {
      reports.forEach((report) => {
        if (report.type === "candidate-pair" && (report.selected === true || (report.state === "succeeded" && report.nominated === true))) selectedPair = report;
      });
    }
    const local = selectedPair === undefined ? undefined : byId.get(selectedPair.localCandidateId);
    const remote = selectedPair === undefined ? undefined : byId.get(selectedPair.remoteCandidateId);
    state.stats = {
      at: Date.now(),
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      transport: transport === undefined ? null : pick(transport, [
        "dtlsState", "iceState", "selectedCandidatePairId", "bytesSent", "bytesReceived", "packetsSent", "packetsReceived",
      ]),
      selectedPair: selectedPair === undefined ? null : pick(selectedPair, [
        "state", "nominated", "selected", "bytesSent", "bytesReceived", "packetsSent", "packetsReceived",
        "currentRoundTripTime", "availableOutgoingBitrate", "requestsSent", "responsesReceived", "consentRequestsSent",
      ]),
      localCandidate: local === undefined ? null : pickCandidate(local),
      remoteCandidate: remote === undefined ? null : pickCandidate(remote),
      candidates: candidateStats,
      configuration: pc.getConfiguration(),
      maxMessageSize: readMaxMessageSize(),
    };
    log("stats-collected", {
      selectedPair: state.stats.selectedPair,
      localCandidate: state.stats.localCandidate,
      remoteCandidate: state.stats.remoteCandidate,
      maxMessageSize: state.stats.maxMessageSize,
    });
  } catch (error) {
    log("stats-error", { message: errorMessage(error) });
  }
}

function pick(source: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function pickCandidate(source: Record<string, any>): Record<string, unknown> {
  return pick(source, [
    "candidateType", "address", "port", "protocol", "url", "relayProtocol", "priority",
    "foundation", "networkType", "usernameFragment", "isRemote",
  ]);
}

setTimeout(() => {
  if (!state.done) fail("browser timeout after 180000ms");
}, 180_000);

void start().catch((error) => fail("start failed: " + errorMessage(error)));
