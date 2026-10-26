// Node side of the #345 0a spike: node-datachannel (libdatachannel) answerer.
// It is deliberately a host peer, not product host code: the same Noise IK and
// record layer from packages/protocol runs over the DataChannel.

import { readFile } from "node:fs/promises";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import ndc from "node-datachannel";
import { keyPairFromPrivate, respondIK } from "../../../../packages/protocol/src/noise.ts";
import {
  SECURE_PROLOGUE,
  SecureSession,
  decodeClientHello,
  encodeHostHello,
  fromBase64Url,
  toBase64Url,
} from "../../../../packages/protocol/src/secure-channel.ts";
import {
  bytePattern,
  makeFrame,
  matchesBytePattern,
  recordStats,
  sha256Hex,
  utf8Length,
} from "../shared/frame.ts";
import { parseCandidate, type PeerConfig } from "../shared/types.ts";

const config = JSON.parse(await readFile(process.argv[2] ?? "", "utf8")) as PeerConfig;
const require = createRequire(import.meta.url);

type LogRecord = Record<string, unknown>;
const log = (event: string, data: LogRecord = {}): void => {
  process.stdout.write(JSON.stringify({ t: Date.now(), event, ...data }) + "\n");
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.on("uncaughtException", (error) => {
  log("error", { kind: "uncaughtException", message: errorMessage(error), stack: error.stack });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  log("error", { kind: "unhandledRejection", message: errorMessage(error) });
  process.exit(1);
});

function platformPackageName(): string | null {
  if (process.platform === "linux") {
    if (process.arch === "x64") return "@node-datachannel/linux-x64-gnu";
    if (process.arch === "arm64") return "@node-datachannel/linux-arm64-gnu";
  }
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "@node-datachannel/darwin-arm64";
    if (process.arch === "x64") return "@node-datachannel/darwin-x64";
  }
  return null;
}

const packageName = platformPackageName();
log("environment", {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  libdatachannel: ndc.getLibraryVersion(),
  platformPackage: packageName,
  platformPackagePath: packageName === null ? null : require.resolve(packageName + "/package.json"),
  cwd: process.cwd(),
  mode: config.mode,
  stun: config.stun,
  sdpMaxMessageSize: config.sdpMaxMessageSize ?? "default",
  bindAddress: config.bindAddress ?? null,
});

function transformSdp(sdp: string): string {
  const mode = config.sdpMaxMessageSize ?? "default";
  if (mode === "default") return sdp;
  const lines = sdp.split(/\r?\n/).filter((line) => !line.startsWith("a=max-message-size:"));
  if (mode === "missing") return lines.join("\r\n");
  const line = "a=max-message-size:" + mode;
  const index = lines.findIndex((entry) => entry.startsWith("a=sctp-port:"));
  if (index >= 0) lines.splice(index + 1, 0, line);
  else lines.push(line);
  return lines.join("\r\n");
}

const hostKey = keyPairFromPrivate(fromBase64Url(config.hostPrivateKey));
const pc = new ndc.PeerConnection("spike-345-host", {
  iceServers: config.stun,
  ...(config.bindAddress === undefined ? {} : { bindAddress: config.bindAddress }),
});
const ws = new WebSocket(config.wsUrl);
const signalQueue: string[] = [];
let wsOpen = false;
let lastPair = "";
let dc: any;
let closed = false;
const state: Record<string, any> = { noise: undefined, responder: undefined, pendingSize: undefined, maxmsg: undefined, connectAcked: false };

function sendSignal(message: Record<string, unknown>): void {
  const text = JSON.stringify(message);
  if (wsOpen) ws.send(text);
  else signalQueue.push(text);
}

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
  if (message.type === "offer") {
    log("offer-received", {
      sdpBytes: String(message.sdp ?? "").length,
      maxMessageSize: String(message.sdp ?? "").split(/\r?\n/).filter((line) => line.startsWith("a=max-message-size:")),
      candidates: String(message.sdp ?? "").split(/\r?\n/).filter((line) => line.startsWith("a=candidate:")).map(parseCandidate),
    });
    try {
      pc.setRemoteDescription(String(message.sdp), "offer");
    } catch (error) {
      log("error", { kind: "setRemoteDescription", message: errorMessage(error) });
      process.exit(1);
    }
  } else if (message.type === "candidate") {
    const info = parseCandidate(String(message.candidate ?? ""));
    log("remote-candidate", info);
    if (info.isMdns && info.address !== undefined) {
      void resolveMdns(info.address);
    }
    try {
      pc.addRemoteCandidate(String(message.candidate), message.mid === null || message.mid === undefined ? "0" : String(message.mid));
    } catch (error) {
      log("add-remote-candidate-error", { message: errorMessage(error), candidate: info.raw });
    }
  }
};

async function resolveMdns(host: string): Promise<void> {
  const started = Date.now();
  log("mdns-resolution-start", { host, via: "node:dns.lookup (getaddrinfo/nsswitch)" });
  try {
    // mdns_minimal on this Linux host takes ~5s for a fresh .local name; keep
    // the probe longer than that so "resolvable but slow" is distinguishable
    // from "unresolvable".
    const addresses = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lookup timeout")), 8000)),
    ]);
    log("mdns-resolution", { host, ok: true, addresses, durationMs: Date.now() - started });
  } catch (error) {
    log("mdns-resolution", { host, ok: false, error: errorMessage(error), code: (error as any)?.code ?? null, durationMs: Date.now() - started });
  }
}

pc.onLocalDescription((sdp, type) => {
  const transformed = transformSdp(sdp);
  log("answer-generated", {
    type,
    sdpBytes: sdp.length,
    originalMaxMessageSize: sdp.split(/\r?\n/).filter((line) => line.startsWith("a=max-message-size:")),
    sentMaxMessageSize: transformed.split(/\r?\n/).filter((line) => line.startsWith("a=max-message-size:")),
    candidates: transformed.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:")).map(parseCandidate),
  });
  sendSignal({ type: "answer", sdp: transformed });
});

pc.onLocalCandidate((candidate, mid) => {
  const info = parseCandidate(candidate);
  log("local-candidate", { ...info, mid });
  sendSignal({ type: "candidate", candidate, mid });
});

pc.onStateChange((state) => log("pc-state", { state }));
pc.onIceStateChange((state) => log("ice-state", { state }));
pc.onGatheringStateChange((state) => log("gathering-state", { state }));

const pairTimer = setInterval(() => {
  try {
    const pair = pc.getSelectedCandidatePair();
    if (pair === null) return;
    const text = JSON.stringify(pair);
    if (text === lastPair) return;
    lastPair = text;
    log("selected-pair", {
      local: pair.local,
      remote: pair.remote,
      localCandidateType: pair.local?.type,
      remoteCandidateType: pair.remote?.type,
      maxMessageSize: pc.maxMessageSize(),
    });
  } catch (error) {
    log("selected-pair-error", { message: errorMessage(error) });
  }
}, 250);

pc.onDataChannel((channel) => {
  dc = channel;
  log("datachannel", { label: channel.getLabel(), id: channel.getId(), protocol: channel.getProtocol(), ordered: true });
  channel.onOpen(() => {
    log("dc-open", {
      maxMessageSize: channel.maxMessageSize(),
      pcMaxMessageSize: pc.maxMessageSize(),
      bufferedAmount: channel.bufferedAmount(),
    });
    void onDcOpen(channel);
  });
  channel.onClosed(() => {
    log("dc-closed", { done: closed, connectAcked: state.connectAcked });
    // The connect test is already done once hello/hello-ack happened; the
    // browser closing first is normal and must not cut the DNS probe short.
    if (state.connectAcked) return;
    if (!closed) finish(1, "DataChannel closed before the test completed");
  });
  channel.onError((error: string) => log("dc-error", { message: error }));
  channel.onMessage((message: string | Buffer | ArrayBuffer) => {
    void onDcMessage(channel, message);
  });
});

async function onDcOpen(channel: any): Promise<void> {
  if (config.mode === "connect") return;
  if (config.mode === "noise") {
    state.noise = {
      phase: "handshake",
      inboundRecords: 0,
      outboundDone: false,
      verdictSent: false,
    };
    state.responder = respondIK({ prologue: SECURE_PROLOGUE, static: hostKey });
    state.hostKeyBase64 = toBase64Url(hostKey.publicKey);
    log("noise-responder-ready", { hostPublicKey: state.hostKeyBase64 });
    return;
  }
  if (config.mode === "maxmsg") {
    log("maxmsg-waiting-for-browser");
  }
}

async function onDcMessage(channel: any, message: string | Buffer | ArrayBuffer): Promise<void> {
  if (typeof message === "string") {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(message) as Record<string, any>;
    } catch {
      log("dc-text", { text: message });
      return;
    }
    log("dc-text", parsed);
    if (config.mode === "connect" && parsed.type === "hello") {
      const pair = pc.getSelectedCandidatePair();
      state.connectAcked = true;
      channel.sendMessage(JSON.stringify({
        type: "hello-ack",
        testId: config.testId,
        maxMessageSize: channel.maxMessageSize(),
        selectedPair: pair,
      }));
      // Long enough for the .local DNS probe (getaddrinfo is ~5s here) and for
      // libdatachannel to try the resolved candidates.
      setTimeout(() => finish(0, undefined), 9000);
      return;
    }
    if (config.mode === "noise" && parsed.type === "spike-verdict") {
      state.noise.browserVerdict = parsed;
      log("noise-browser-verdict", parsed);
      void maybeFinishNoise();
      return;
    }
    if (config.mode === "maxmsg") {
      if (parsed.type === "maxmsg-ready") {
        log("maxmsg-browser-ready", { maxMessageSize: channel.maxMessageSize(), pcMaxMessageSize: pc.maxMessageSize() });
        void runMaxMessage(channel);
      } else if (parsed.type === "size-received") {
        log("maxmsg-browser-received", parsed);
        const pending = state.pendingSize;
        if (pending !== undefined) {
          pending.received = parsed;
          pending.maybeResolve();
        }
      } else if (parsed.type === "size-skip") {
        log("maxmsg-browser-skip-echo", parsed);
        const pending = state.pendingSize;
        if (pending !== undefined) {
          pending.b2hError = "skipped: " + String(parsed.reason ?? "");
          pending.maybeResolve();
        }
      } else if (parsed.type === "size-error") {
        log("maxmsg-browser-send-error", parsed);
        const pending = state.pendingSize;
        if (pending !== undefined) {
          pending.b2hError = String(parsed.error ?? "browser echo failed");
          pending.maybeResolve();
        }
      }
      return;
    }
    return;
  }
  const bytes = toBytes(message);
  if (config.mode === "noise") {
    await onNoiseRecord(bytes);
    return;
  }
  if (config.mode === "maxmsg") {
    log("maxmsg-echo-received", { size: bytes.byteLength, patternOk: matchesBytePattern(bytes) });
    const pending = state.pendingSize;
    if (pending !== undefined) {
      pending.echo = bytes;
      pending.maybeResolve();
    }
    return;
  }
}

function toBytes(message: string | Buffer | ArrayBuffer): Uint8Array {
  if (typeof message === "string") return new TextEncoder().encode(message);
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

async function onNoiseRecord(bytes: Uint8Array): Promise<void> {
  const noise = state.noise;
  if (noise === undefined) return;
  if (noise.session === undefined) {
    try {
      const opened = state.responder.readMessage1(bytes);
      const hello = decodeClientHello(opened.payload);
      log("noise-handshake-message1", {
        bytes: bytes.byteLength,
        clientHello: hello,
        remoteStatic: toBase64Url(opened.remoteStatic),
      });
      const message2 = state.responder.writeMessage2(encodeHostHello({ v: 1 }));
      dc.sendMessageBinary(Buffer.from(message2.message));
      noise.session = new SecureSession(message2.result);
      noise.phase = "encrypted";
      noise.handshakeDoneAt = Date.now();
      log("noise-handshake-done", { bytes: message2.message.byteLength });
      void startNoiseOutbound();
    } catch (error) {
      log("error", { kind: "noise-handshake", message: errorMessage(error) });
      finish(1, "noise handshake failed: " + errorMessage(error));
    }
    return;
  }
  try {
    const text = noise.session.open(bytes);
    noise.inboundRecords += 1;
    noise.inboundCiphertextBytes = (noise.inboundCiphertextBytes ?? 0) + bytes.byteLength;
    if (text === undefined) return;
    if (noise.browserFrame === undefined) {
      const expected = makeFrame(config.frameSeed ?? 345, config.frameBytes ?? 8 * 1024 * 1024);
      const match = text === expected;
      noise.browserFrame = {
        plaintextBytes: utf8Length(text),
        sha256: sha256Hex(new TextEncoder().encode(text)),
        expectedSha256: sha256Hex(new TextEncoder().encode(expected)),
        match,
        records: noise.inboundRecords,
        ciphertextBytes: noise.inboundCiphertextBytes,
        receivedAt: Date.now(),
      };
      noise.phase = "browser-frame-received";
      log("noise-browser-frame-received", { ...noise.browserFrame });
      noise.inboundRecords = 0;
      noise.inboundCiphertextBytes = 0;
      const verdict = {
        type: "spike-verdict",
        direction: "b2h",
        ok: match,
        plaintextBytes: noise.browserFrame.plaintextBytes,
        sha256: noise.browserFrame.sha256,
        records: noise.browserFrame.records,
      };
      noise.verdictPending = verdict;
      sendPendingVerdict();
      void maybeFinishNoise();
      return;
    }
    if (noise.browserVerdict === undefined && text.startsWith("{\"type\":\"spike-verdict\"")) {
      noise.browserVerdict = JSON.parse(text);
      log("noise-browser-verdict", noise.browserVerdict);
      void maybeFinishNoise();
      return;
    }
    log("noise-unexpected-frame", { bytes: text.length });
  } catch (error) {
    log("error", { kind: "noise-open", message: errorMessage(error) });
    finish(1, "noise record open failed: " + errorMessage(error));
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
    log("error", { kind: "noise-outbound", message: errorMessage(error) });
    finish(1, "noise outbound pump failed: " + errorMessage(error));
  }
}

function sendPendingVerdict(): void {
  const noise = state.noise;
  if (noise === undefined || noise.verdictSent) return;
  if (noise.outboundDone !== true || noise.verdictPending === undefined) return;
  try {
    const records = noise.session.seal(JSON.stringify(noise.verdictPending));
    for (const record of records) dc.sendMessageBinary(Buffer.from(record));
    noise.verdictSent = true;
    noise.verdictedAt = Date.now();
    log("noise-verdict-sent", { records: records.length, verdict: noise.verdictPending });
  } catch (error) {
    log("error", { kind: "noise-verdict", message: errorMessage(error) });
    finish(1, "noise verdict send failed: " + errorMessage(error));
  }
}

async function maybeFinishNoise(): Promise<void> {
  const noise = state.noise;
  if (noise === undefined) return;
  if (noise.outboundDone !== true) return;
  if (noise.browserFrame === undefined) return;
  if (noise.browserVerdict === undefined) return;
  if (noise.verdictSent !== true) return;
  if (noise.finished) return;
  noise.finished = true;
  log("noise-complete", {
    hostFrameVerifiedByBrowser: noise.browserVerdict,
    browserFrameVerifiedByHost: noise.browserFrame,
  });
  finish(0, undefined);
}

type PumpMetrics = {
  records: number;
  sent: number;
  highWater: number;
  lowWater: number;
  maxBuffered: number;
  lowEvents: number;
  falseSends: number;
  durationMs: number;
};

async function pumpRecords(channel: any, records: Uint8Array[]): Promise<PumpMetrics> {
  const highWater = 256 * 1024;
  const lowWater = 64 * 1024;
  const timeoutMs = 60_000;
  channel.setBufferedAmountLowThreshold(lowWater);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let index = 0;
    let maxBuffered = 0;
    let lowEvents = 0;
    let falseSends = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (tickTimer !== undefined) clearTimeout(tickTimer);
    };
    const fail = (error: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const tick = (delayMs: number): void => {
      if (finished || tickTimer !== undefined) return;
      tickTimer = setTimeout(() => {
        tickTimer = undefined;
        run();
      }, delayMs);
    };
    const run = (): void => {
      if (finished) return;
      let buffered = channel.bufferedAmount();
      try {
        while (index < records.length) {
          buffered = channel.bufferedAmount();
          if (buffered > maxBuffered) maxBuffered = buffered;
          if (buffered >= highWater) break;
          // libdatachannel queues the message when this returns false
          // (SctpTransport::send pushes to mSendQueue and returns false).
          // It is NOT a rejection: advancing is required or the record is
          // duplicated and the Noise nonce sequence breaks.
          const accepted = channel.sendMessageBinary(Buffer.from(records[index]!));
          if (accepted === false) falseSends += 1;
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
          falseSends,
          durationMs: Date.now() - started,
        });
        return;
      }
      // onBufferedAmountLow usually wakes us, but a short poll keeps the pump
      // moving if a callback is missed; it never resends a record.
      tick(buffered >= highWater ? 50 : 0);
    };
    channel.onBufferedAmountLow(() => {
      lowEvents += 1;
      log("buffered-amount-low", {
        bufferedAmount: channel.bufferedAmount(),
        sent: index,
        records: records.length,
      });
      tick(0);
    });
    timer = setTimeout(() => fail("pump made no progress within " + timeoutMs + "ms"), timeoutMs);
    log("pump-start", {
      records: records.length,
      highWater,
      lowWater,
      bufferedAmount: channel.bufferedAmount(),
    });
    run();
  });
}

async function runMaxMessage(channel: any): Promise<void> {
  const sizes = config.sizes ?? [65535, 65536, 65537, 131072, 262144, 262145];
  const results: Array<Record<string, unknown>> = [];
  for (const size of sizes) {
    log("maxmsg-size-start", { size, maxMessageSize: channel.maxMessageSize(), pcMaxMessageSize: pc.maxMessageSize() });
    try {
      channel.sendMessage(JSON.stringify({ type: "size-start", size }));
    } catch (error) {
      log("maxmsg-size-start-send-error", { size, message: errorMessage(error) });
    }
    let sendError: string | undefined;
    try {
      // false means libdatachannel queued the message (see SctpTransport::send);
      // it is not a rejection. The browser's size-received ack is the real h2b check.
      const queued = channel.sendMessageBinary(Buffer.from(bytePattern(size)));
      if (queued === false) log("maxmsg-host-send-queued", { size });
    } catch (error) {
      sendError = errorMessage(error);
      log("maxmsg-host-send-error", { size, message: sendError });
    }
    if (sendError !== undefined) {
      const result = { size, ok: false, h2b: false, b2h: false, phase: "host-send", error: sendError };
      results.push(result);
      log("maxmsg-size-result", result);
      try { channel.sendMessage(JSON.stringify({ type: "size-result", ...result })); } catch {}
      break;
    }
    const outcome = await new Promise<any>((resolve) => {
      const pending: any = { size, received: null, echo: null, b2hError: null, settled: false };
      const timer = setTimeout(() => {
        if (pending.settled) return;
        pending.settled = true;
        state.pendingSize = undefined;
        resolve(pending);
      }, 15_000);
      pending.maybeResolve = () => {
        if (pending.settled) return;
        if (pending.received === null) return;
        if (pending.echo === null && pending.b2hError === null) return;
        pending.settled = true;
        clearTimeout(timer);
        state.pendingSize = undefined;
        resolve(pending);
      };
      state.pendingSize = pending;
    });
    if (outcome.received === null) {
      const result = { size, ok: false, h2b: false, b2h: false, phase: "receive-ack", error: "browser did not acknowledge the message within 15000ms" };
      results.push(result);
      log("maxmsg-size-result", result);
      try { channel.sendMessage(JSON.stringify({ type: "size-result", ...result })); } catch {}
      break;
    }
    const h2bOk = outcome.received.patternOk === true;
    let b2hOk = false;
    let b2hReason: string | undefined;
    if (outcome.echo !== null) {
      b2hOk = outcome.echo.byteLength === size && matchesBytePattern(outcome.echo);
      if (!b2hOk) b2hReason = "echo pattern mismatch";
    } else {
      b2hReason = outcome.b2hError ?? "no echo within 15000ms";
    }
    const result = {
      size,
      ok: h2bOk && b2hOk,
      h2b: h2bOk,
      b2h: b2hOk,
      phase: "complete",
      ...(b2hOk ? { echoBytes: outcome.echo.byteLength } : { error: b2hReason }),
    };
    results.push(result);
    log("maxmsg-size-result", result);
    try { channel.sendMessage(JSON.stringify({ type: "size-result", ...result })); } catch {}
    // Keep probing h2b after a b2h failure; the browser skips later echoes.
    if (!h2bOk) break;
  }
  state.maxmsg = { results, maxMessageSize: channel.maxMessageSize(), pcMaxMessageSize: pc.maxMessageSize() };
  log("maxmsg-complete", state.maxmsg);
  try { channel.sendMessage(JSON.stringify({ type: "done", results })); } catch {}
  finish(0, undefined);
}

function finish(code: number, error: string | undefined): void {
  if (closed) return;
  closed = true;
  clearInterval(pairTimer);
  log("finish", {
    code,
    error: error ?? null,
    selectedPair: pc.getSelectedCandidatePair(),
    maxMessageSize: pc.maxMessageSize(),
    dcMaxMessageSize: dc === undefined ? null : dc.maxMessageSize(),
    noise: state.noise,
    maxmsg: state.maxmsg,
  });
  try { dc?.close(); } catch {}
  try { pc.close(); } catch {}
  setTimeout(() => process.exit(code), 400);
}

setTimeout(() => {
  log("timeout", {});
  finish(1, "peer timeout after 180000ms");
}, 180_000);
