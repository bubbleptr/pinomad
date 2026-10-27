// Deterministic coordinator tests for the RTC standby path: a fake platform
// Peer plus a fake host on the DataChannel, no native library and no sleeps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, respondIK, type KeyPair } from "../src/noise.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PROTOCOL, type ClientFrame, type ServerFrame } from "../src/frames.ts";
import type { ConnectionMode } from "../src/connection-mode.ts";
import type { RtcCandidatePair } from "../src/rtc.ts";
import type { RtcDataChannel, RtcPeer, RtcPlatform, RtcSendOutcome } from "../src/rtc-carrier.ts";
import {
  connectRemoteDurable,
  DirectUnavailableError,
  DisconnectedError,
  type RemoteDurable,
  type RemoteDurableOptions,
} from "../src/remote-durable.ts";
import type { RemoteCandidate } from "../src/remote-candidates.ts";
import {
  decodeClientHello,
  encodeHostHello,
  SECURE_PROLOGUE,
  SecureSession,
} from "../src/secure-channel.ts";
import type { FrameConnection, FrameHandlers } from "../src/transport.ts";

const SNAPSHOTS: Record<string, unknown> = {
  conversations: [],
  index: { projects: [], conversations: [] },
  devices: { devices: [] },
  tasks: { tasks: {} },
  mcp: null,
  models: [],
  auth: { logins: [] },
  settings: {
    defaultModel: null,
    defaultThinkingLevel: null,
    steeringMode: "all",
    followUpMode: "all",
    custom: [],
  },
  agents: { roles: [], problems: [] },
  providers: { providers: [], logins: [] },
};

const snapshotFor = (stream: string): unknown => {
  if (stream in SNAPSHOTS) return SNAPSHOTS[stream];
  if (stream.startsWith("conversation:")) return { conversation: { id: Number(stream.split(":")[1]) }, entries: [] };
  if (stream.startsWith("doc:")) return { requests: [] };
  return null;
};

const RT_ANSWER = "v=0\r\na=max-message-size:65536\r\n";
const id = (value: number): ConversationId => value as ConversationId;

const hello = (rtc = true): ServerFrame => ({
  type: "hello",
  protocol: PROTOCOL,
  session: { id: "fake", directory: "" },
  models: [],
  docs: [],
  toolPresentations: {},
  defaults: {},
  ...(rtc ? { rtc: { stun: [], signalOnly: true } } : {}),
});

/** One scripted WebSocket that answers rtcOffer by opening the fake Peer. */
function wsNetwork(script: {
  hello?: ServerFrame;
  rtcWorld: FakeRtcWorld;
  holdCall?: (method: string) => boolean;
}) {
  const opens: { candidate: RemoteCandidate; handlers: FrameHandlers; frames: ClientFrame[]; closeCalls: number }[] = [];
  const attempts: string[] = [];
  const transport = (candidate: RemoteCandidate) => ({
    label: candidate.url,
    open(handlers: FrameHandlers): FrameConnection {
      const record = { candidate, handlers, frames: [] as ClientFrame[], closeCalls: 0 };
      opens.push(record);
      let closed = false;
      const connection: FrameConnection = {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          record.frames.push(frame);
          if (frame.type === "call" && frame.method === "rtcOffer") {
            attempts.push(frame.args.attempt);
            script.rtcWorld.lastOffer = frame.args.sdp;
            queueMicrotask(() => {
              if (closed) return;
              handlers.message(JSON.stringify({ type: "result", id: frame.id, ok: true, value: { sdp: RT_ANSWER } }));
            });
          } else if (frame.type === "subscribe") {
            queueMicrotask(() => {
              if (closed) return;
              handlers.message(JSON.stringify({ type: "snapshot", stream: frame.stream, value: snapshotFor(frame.stream) }));
            });
          } else if (frame.type === "call" && script.holdCall?.(frame.method) !== true) {
            queueMicrotask(() => {
              if (closed) return;
              handlers.message(JSON.stringify({ type: "result", id: frame.id, ok: true, value: {} }));
            });
          }
        },
        close() {
          record.closeCalls += 1;
          if (closed) return;
          closed = true;
          queueMicrotask(() => handlers.closed(1000));
        },
      };
      queueMicrotask(() => {
        if (closed) return;
        handlers.opened?.();
        handlers.authenticated?.();
        handlers.message(JSON.stringify(script.hello ?? hello(true)));
      });
      return connection;
    },
  });
  return { opens, transport, attempts };
}

class FakeDc implements RtcDataChannel {
  readonly sent: Uint8Array[] = [];
  readonly calls: ClientFrame[] = [];
  readonly pings: string[] = [];
  bufferedAmount = 0;
  #open: (() => void) | undefined;
  #message: ((record: Uint8Array) => void) | undefined;
  #closed: ((reason?: string) => void) | undefined;
  #low: (() => void) | undefined;
  #session: SecureSession | undefined;
  #handshake: ReturnType<typeof respondIK> | undefined;
  #closedFlag = false;
  holdPing: (n: number) => boolean = () => false;
  readonly heldPings: ClientFrame[] = [];
  holdStreams = new Set<string>();
  sendOutcome: RtcSendOutcome = "accepted";
  onSend: ((record: Uint8Array) => void) | undefined;

  get isClosed(): boolean {
    return this.#closedFlag;
  }

  readonly hostKey: KeyPair;
  readonly finish: () => Promise<ServerFrame> | undefined;

  constructor(hostKey: KeyPair, finish: () => Promise<ServerFrame> | undefined) {
    this.hostKey = hostKey;
    this.finish = finish;
  }

  onOpen(listener: () => void): void { this.#open = listener; }
  onMessage(listener: (record: Uint8Array) => void): void { this.#message = listener; }
  onClosed(listener: (reason?: string) => void): void { this.#closed = listener; }
  onBufferedAmountLow(listener: () => void): void { this.#low = listener; }

  open(): void {
    if (this.#closedFlag) return;
    queueMicrotask(() => this.#open?.());
  }

  send(record: Uint8Array): RtcSendOutcome {
    if (this.sendOutcome === "rejected") return "rejected";
    this.sent.push(record);
    this.onSend?.(record);
    if (this.#session === undefined) {
      try {
        this.#handshake ??= respondIK({ prologue: SECURE_PROLOGUE, static: this.hostKey });
        const { payload } = this.#handshake.readMessage1(record);
        decodeClientHello(payload);
        const { message, result } = this.#handshake.writeMessage2(encodeHostHello({ v: 1 }));
        this.#session = new SecureSession(result);
        this.deliver(message);
        const first = this.finish();
        if (first !== undefined) void first.then((frame) => this.sendFrame(frame));
      } catch {
        this.close("noise failed");
      }
      return "accepted";
    }
    try {
      const text = this.#session.open(record);
      if (text !== undefined) this.receive(JSON.parse(text) as ClientFrame);
    } catch {
      this.close("record failed");
    }
    return "accepted";
  }

  deliver(record: Uint8Array): void {
    queueMicrotask(() => this.#message?.(record));
  }

  sendFrame(frame: ServerFrame): void {
    if (this.#closedFlag || this.#session === undefined) return;
    for (const record of this.#session.seal(JSON.stringify(frame))) this.deliver(record);
  }

  receive(frame: ClientFrame): void {
    this.calls.push(frame);
    if (frame.type === "call" && frame.method === "ping") {
      const id = frame.args.id;
      this.pings.push(id);
      if (this.holdPing(this.pings.length)) {
        this.heldPings.push(frame);
        return;
      }
      queueMicrotask(() => {
        this.sendFrame({ type: "result", id: frame.id, ok: true, value: { id } });
      });
      return;
    }
    if (frame.type === "call") {
      queueMicrotask(() => this.sendFrame({ type: "result", id: frame.id, ok: true, value: {} }));
      return;
    }
    if (frame.type === "subscribe") {
      if (this.holdStreams.has(frame.stream)) return;
      queueMicrotask(() => {
        this.sendFrame({ type: "snapshot", stream: frame.stream, value: snapshotFor(frame.stream) });
      });
    }
  }

  releaseStream(stream: string): void {
    this.holdStreams.delete(stream);
    this.sendFrame({ type: "snapshot", stream: stream as never, value: snapshotFor(stream) });
  }

  sendEnded(stream: string): void {
    this.sendFrame({ type: "ended", stream: stream as never, reason: "gone" });
  }

  releaseHeldPings(): void {
    for (const frame of this.heldPings.splice(0)) this.releasePing(frame);
  }

  releaseFirstHeldPing(): void {
    const frame = this.heldPings.shift();
    if (frame !== undefined) this.releasePing(frame);
  }

  releasePing(frame: ClientFrame): void {
    if (frame.type !== "call") return;
    queueMicrotask(() => {
      const args = frame.args as { id: string };
      this.sendFrame({ type: "result", id: frame.id, ok: true, value: { id: args.id } });
    });
  }

  close(reason?: string): void {
    if (this.#closedFlag) return;
    this.#closedFlag = true;
    this.#closed?.(reason);
  }
}

class FakePeer implements RtcPeer {
  readonly channel: FakeDc;
  readonly offerSdp = "v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 9000 typ host\r\n";
  answer: string | undefined;
  constructor(hostKey: KeyPair, finish: () => Promise<ServerFrame> | undefined) {
    this.channel = new FakeDc(hostKey, finish);
  }
  acceptAnswer(sdp: string): void {
    this.answer = sdp;
    this.channel.open();
  }
  selectedPair(): RtcCandidatePair {
    return {
      local: { type: "host", address: "5f9a1c2e-1234-4abc-9def-0123456789ab.local" },
      remote: { type: "srflx", address: "100.64.0.7:41000" },
    };
  }
  close(): void { this.channel.close("peer closed"); }
}

class FakeRtcWorld {
  readonly hostKey = generateKeyPair();
  readonly device = generateKeyPair();
  readonly peers: FakePeer[] = [];
  readonly stuns: string[][] = [];
  lastOffer: string | undefined;
  failCreate: string | undefined;
  finishHello: () => Promise<ServerFrame> | undefined = () => Promise.resolve(hello(true));
  readonly platform: RtcPlatform = {
    createPeer: async (stun) => {
      this.stuns.push([...stun]);
      if (this.failCreate !== undefined) throw new Error(this.failCreate);
      const peer = new FakePeer(this.hostKey, () => this.finishHello());
      this.peers.push(peer);
      return peer;
    },
  };
  get dc(): FakeDc {
    const peer = this.peers.at(-1);
    if (peer === undefined) throw new Error("no peer created");
    return peer.channel;
  }
}

/** A signal-only WebSocket: minimal hello, then rtcOffer answers. */
function signalNetwork(world: FakeRtcWorld) {
  const opens: { candidate: RemoteCandidate; frames: ClientFrame[]; closeCalls: number }[] = [];
  const transport = (candidate: RemoteCandidate) => ({
    label: candidate.url,
    open(handlers: FrameHandlers): FrameConnection {
      const record = { candidate, frames: [] as ClientFrame[], closeCalls: 0 };
      opens.push(record);
      let closed = false;
      const connection: FrameConnection = {
        send(data) {
          const frame = JSON.parse(data) as ClientFrame;
          record.frames.push(frame);
          if (frame.type === "call" && frame.method === "rtcOffer") {
            world.lastOffer = frame.args.sdp;
            queueMicrotask(() => {
              if (closed) return;
              handlers.message(JSON.stringify({ type: "result", id: frame.id, ok: true, value: { sdp: RT_ANSWER } }));
            });
          }
        },
        close() {
          record.closeCalls += 1;
          if (closed) return;
          closed = true;
          queueMicrotask(() => handlers.closed(1000));
        },
      };
      queueMicrotask(() => {
        if (closed) return;
        handlers.opened?.();
        handlers.authenticated?.();
        handlers.message(JSON.stringify({
          type: "signalHello",
          protocol: PROTOCOL,
          rtc: { stun: [], signalOnly: true },
        } satisfies ServerFrame));
      });
      return connection;
    },
  });
  return { opens, transport };
}

/** Advance past the 1s upgrade delay, the warm ping and the handoff. */
async function upgrade(remote: RemoteDurable, world: FakeRtcWorld, network: ReturnType<typeof wsNetwork>) {
  await remote.controller.switchConversation(id(1));
  await flush();
  await vi.advanceTimersByTimeAsync(1_100);
  await flush();
  expect(world.peers.length).toBeGreaterThan(0);
  const dc = world.dc;
  await vi.advanceTimersByTimeAsync(400);
  await flush();
  expect(remote.rtcDiagnostics().path).toBe("p2p");
  expect(network.opens.length).toBeGreaterThan(0);
  return dc;
}

const loopback = (url = "ws://127.0.0.1:7420/secure"): RemoteCandidate => ({ url, role: "loopback" });
const relay = (url = "wss://relay.example/secure"): RemoteCandidate => ({ url, role: "relay" });
const direct = (url = "wss://direct.example/secure"): RemoteCandidate => ({ url, role: "direct" });

function options(
  network: ReturnType<typeof wsNetwork>,
  world: FakeRtcWorld,
  mode: ConnectionMode = "auto",
  overrides: Partial<NonNullable<Extract<RemoteDurableOptions, { candidates: unknown }>>> = {},
): RemoteDurableOptions {
  return {
    candidates: [relay(), direct()],
    openTransport: network.transport,
    candidateTimeouts: { socketOpenMs: 100, noiseMs: 100, helloMs: 100, syncMs: 1_000 },
    roundTimeoutMs: 10_000,
    connectionMode: mode,
    rtc: {
      platform: world.platform,
      hostKey: world.hostKey.publicKey,
      device: world.device,
      signalOnlyHint: true,
    },
    ...overrides,
  };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const ready = async (pending: Promise<RemoteDurable>): Promise<RemoteDurable> => {
  let done: RemoteDurable | undefined;
  let failed: unknown;
  pending.then((remote) => (done = remote), (error: unknown) => (failed = error));
  for (let i = 0; i < 40 && done === undefined && failed === undefined; i++) await flush();
  if (done === undefined) throw new Error(`remote did not become ready: ${failed instanceof Error ? failed.message : String(failed)}`);
  return done;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RTC standby handoff", () => {
  it("upgrades, bounds the idle window, and sends a submit that arrives before the pong to the new carrier", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      expect(remote.rtcDiagnostics().path).toBe("relay");
      await remote.controller.switchConversation(id(1));
      await flush();
      // Upgrade starts after the 1s delay; offer/answer and Noise complete.
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(world.peers).toHaveLength(1);
      expect(world.lastOffer).toBe(world.peers[0]!.offerSdp);
      const dc = world.dc;
      // Warm ping is the first ping, the commit preverify is the second.
      dc.holdPing = (count) => count === 2;
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      expect(dc.pings).toHaveLength(2);

      const submitted = remote.controller.submit("during commit", "followUp");
      await flush();
      // The barrier queue holds it: neither carrier has seen a submit.
      expect(network.opens[0]!.frames.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(false);
      expect(dc.calls.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(false);

      dc.holdPing = () => false;
      dc.releaseHeldPings();
      await vi.advanceTimersByTimeAsync(10);
      await flush();
      await submitted;
      expect(dc.calls.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(true);
      expect(remote.rtcDiagnostics().path).toBe("p2p");
    } finally {
      remote.close();
    }
  });

  it("reports the selected pair's scopes, then freezes it into an ageing failure", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      const dc = await upgrade(remote, world, network);
      const selected = remote.rtcDiagnostics().selectedPair;
      expect(selected?.local).toMatchObject({ type: "host", scope: "unknown" });
      expect(selected?.remote).toMatchObject({ type: "srflx", scope: "tailnet" });
      expect(remote.rtcDiagnostics().lastFailure).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);
      dc.close("the ICE connection failed");
      await flush();
      const failure = remote.rtcDiagnostics().lastFailure;
      expect(failure?.stage).toBe("liveness");
      expect(failure?.reason).toContain("the ICE connection failed");
      expect(failure?.pair).toEqual(selected);
      expect(failure?.agoMs).toBe(0);
      expect(remote.rtcDiagnostics().selectedPair).toBeUndefined();

      await vi.advanceTimersByTimeAsync(7_000);
      await flush();
      expect(remote.rtcDiagnostics().lastFailure?.agoMs).toBe(7_000);
    } finally {
      remote.close();
    }
  });

  it("uses a unique RTC attempt for every coordinator instance", async () => {
    const firstWorld = new FakeRtcWorld();
    const firstNetwork = wsNetwork({ rtcWorld: firstWorld });
    const first = await ready(connectRemoteDurable(options(firstNetwork, firstWorld)));
    const secondWorld = new FakeRtcWorld();
    const secondNetwork = wsNetwork({ rtcWorld: secondWorld });
    const second = await ready(connectRemoteDurable(options(secondNetwork, secondWorld)));
    try {
      await first.controller.switchConversation(id(1));
      await second.controller.switchConversation(id(1));
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(firstNetwork.attempts[0]).toMatch(/^rtc-[0-9a-f]{16}-\d+$/);
      expect(secondNetwork.attempts[0]).toMatch(/^rtc-[0-9a-f]{16}-\d+$/);
      expect(secondNetwork.attempts[0]).not.toBe(firstNetwork.attempts[0]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("doubles the preparation cooldown after each failed attempt", async () => {
    const world = new FakeRtcWorld();
    world.failCreate = "no usable candidates";
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(world.stuns).toHaveLength(1);
      expect(remote.rtcDiagnostics().cooldownRemainingMs).toBeGreaterThan(29_000);
      expect(remote.rtcDiagnostics().lastFailure?.stage).toBe("signal");
      await vi.advanceTimersByTimeAsync(30_100);
      await flush();
      expect(world.stuns).toHaveLength(2);
      expect(remote.rtcDiagnostics().cooldownRemainingMs).toBeGreaterThan(59_000);
      expect(remote.rtcDiagnostics().path).toBe("relay");
    } finally {
      remote.close();
    }
  });

  it("waits up to 30s for idle and then retries without counting a failure", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world, holdCall: (method) => method === "listFiles" });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(world.peers).toHaveLength(1);
      // Hold a real in-flight call before the 300ms idle window closes.
      const held = remote.controller.listFiles({ kind: "project", path: "/tmp", checkout: "project" }, "");
      await flush();
      await vi.advanceTimersByTimeAsync(30_100);
      await flush();
      expect(remote.rtcDiagnostics().cooldownRemainingMs).toBe(0);
      expect(remote.rtcDiagnostics().path).toBe("relay");
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(world.peers.length).toBeGreaterThanOrEqual(2);
      let done = false;
      held.then(() => (done = true), () => (done = true));
      await flush();
      expect(done).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("releases the barrier and sends queued calls back to the old carrier when preverify fails", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await remote.controller.switchConversation(id(1));
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      const dc = world.dc;
      dc.holdPing = (count) => count === 2;
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      expect(dc.pings).toHaveLength(2);
      const submitted = remote.controller.submit("back to relay", "followUp");
      await flush();
      await vi.advanceTimersByTimeAsync(3_100);
      await flush();
      await submitted;
      expect(network.opens[0]!.frames.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(true);
      expect(dc.calls.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(false);
      expect(remote.rtcDiagnostics().path).toBe("relay");
      expect(remote.rtcDiagnostics().cooldownRemainingMs).toBeGreaterThan(0);
    } finally {
      remote.close();
    }
  });

  it("keeps the old carrier's close callback from starting a reconnect during handoff", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await upgrade(remote, world, network);
      const opens = network.opens.length;
      expect(opens).toBe(1);
      expect(network.opens[0]!.closeCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(network.opens).toHaveLength(opens);
      expect(remote.rtcDiagnostics().path).toBe("p2p");
    } finally {
      remote.close();
    }
  });

  it("releases the handoff queue when a selected stream ends", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await remote.controller.switchConversation(id(1));
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      const dc = world.dc;
      dc.holdStreams.add("conversation:1");
      dc.holdPing = (count) => count === 2;
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      const submitted = remote.controller.submit("after ended", "followUp");
      await flush();
      dc.holdPing = () => false;
      dc.releaseHeldPings();
      await vi.advanceTimersByTimeAsync(10);
      await flush();
      expect(dc.calls.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(false);
      dc.sendEnded("conversation:1");
      await flush();
      await submitted;
      expect(dc.calls.some((frame) => frame.type === "call" && frame.method === "submit")).toBe(true);
    } finally {
      remote.close();
    }
  });

  it("fails queued calls on a handoff sync failure and never carries them into the round", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await remote.controller.switchConversation(id(1));
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      const dc = world.dc;
      dc.holdStreams.add("conversation:1");
      dc.holdPing = (count) => count === 2;
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      const changes = remote.controller.changes();
      let failed: Error | undefined;
      changes.catch((error: Error) => (failed = error));
      dc.holdPing = () => false;
      dc.releaseHeldPings();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(failed).toBeInstanceOf(DisconnectedError);
      expect(network.opens.length).toBeGreaterThan(1);
      const all = network.opens.flatMap((open) => open.frames);
      expect(all.some((frame) => frame.type === "call" && frame.method === "changes")).toBe(false);
      expect(remote.rtcDiagnostics().path).toBe("relay");
    } finally {
      remote.close();
    }
  });

  it("falls back after 15s without a pong and does not upgrade again for 60s", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      const dc = await upgrade(remote, world, network);
      dc.holdPing = () => true;
      await vi.advanceTimersByTimeAsync(15_100);
      await flush();
      expect(remote.rtcDiagnostics().path).toBe("relay");
      expect(remote.view.current().unauthorized).toBeUndefined();
      expect(network.opens.length).toBeGreaterThan(1);
      expect(world.peers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(59_000);
      await flush();
      expect(world.peers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_100);
      await flush();
      expect(world.peers.length).toBeGreaterThan(1);
    } finally {
      remote.close();
    }
  });

  it("clears a preparation cooldown on a network change at most once per minute and still probes P2P", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const listeners: (() => void)[] = [];
    const remote = await ready(connectRemoteDurable({
      ...options(network, world),
      network: { subscribe: (listener) => { listeners.push(listener); return () => undefined; } },
    }));
    try {
      const dc = await upgrade(remote, world, network);
      dc.holdPing = () => true;
      listeners[0]!();
      await flush();
      expect(dc.pings.length).toBeGreaterThan(2);
      await vi.advanceTimersByTimeAsync(3_100);
      await flush();
      expect(remote.rtcDiagnostics().path).toBe("relay");
      const peers = world.peers.length;
      listeners[0]!();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(world.peers.length).toBe(peers);
    } finally {
      remote.close();
    }
  });

  it("never creates an RTC peer or signal connection in Relay only", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world, "relayOnly")));
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(world.stuns).toHaveLength(0);
      expect(world.peers).toHaveLength(0);
      expect(network.opens).toHaveLength(1);
      expect(network.opens[0]!.candidate.role).toBe("relay");
    } finally {
      remote.close();
    }
  });

  it("filters business candidates per mode and keeps relay only for Direct-only signaling", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const signal = signalNetwork(world);
    const base = options(network, world, "directOnly");
    const remote = await ready(connectRemoteDurable({
      ...base,
      candidates: [relay(), direct()],
      rtc: { ...base.rtc!, openSignalTransport: signal.transport },
    }));
    try {
      expect(network.opens[0]!.candidate.role).toBe("direct");
      expect(network.opens.some((open) => open.candidate.role === "relay")).toBe(false);
      const dc = await upgrade(remote, world, network);
      expect(dc.calls.some((frame) => frame.type === "subscribe")).toBe(true);
      remote.setConnectionMode("relayOnly");
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(network.opens.at(-1)!.candidate.role).toBe("relay");
      expect(remote.rtcDiagnostics().path).toBe("relay");
    } finally {
      remote.close();
    }
  });

  it("connects through a signal-only relay in Direct only and reports direct unavailable on failure", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const signal = signalNetwork(world);
    const base = options(network, world, "directOnly");
    const remote = await ready(connectRemoteDurable({
      ...base,
      candidates: [relay()],
      rtc: { ...base.rtc!, openSignalTransport: signal.transport },
    }));
    try {
      expect(network.opens).toHaveLength(0);
      expect(signal.opens).toHaveLength(1);
      expect(signal.opens[0]!.frames.some((frame) => frame.type === "call" && frame.method === "rtcOffer")).toBe(true);
      expect(remote.rtcDiagnostics().path).toBe("p2p");
      expect(remote.view.current().connection).toBe("connected");
    } finally {
      remote.close();
    }

    const failing = new FakeRtcWorld();
    failing.failCreate = "no peer";
    const failingNetwork = wsNetwork({ rtcWorld: failing });
    const failingSignal = signalNetwork(failing);
    const failingBase = options(failingNetwork, failing, "directOnly");
    const error = await connectRemoteDurable({
      ...failingBase,
      candidates: [relay()],
      rtc: { ...failingBase.rtc!, openSignalTransport: failingSignal.transport },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DirectUnavailableError);
    expect((error as DirectUnavailableError).reason).toContain("no peer");
    expect((error as Error).message).toContain("Direct connection unavailable");
    expect(failingNetwork.opens).toHaveLength(0);
  });

  it("does not touch RTC at all when the platform declares it unsupported", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world, hello: hello(true) });
    const remote = await ready(connectRemoteDurable({
      ...options(network, world),
      rtc: undefined,
    }));
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(world.stuns).toHaveLength(0);
      expect(world.peers).toHaveLength(0);
      expect(network.opens).toHaveLength(1);
      expect(network.opens[0]!.frames.some((frame) => frame.type === "call" && frame.method === "rtcOffer")).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("fails queued calls when the RTC carrier closes during the handoff sync", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      await remote.controller.switchConversation(id(1));
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      const dc = world.dc;
      dc.holdStreams.add("index");
      dc.holdPing = (count) => count === 2;
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      const changes = remote.controller.changes();
      let failed: Error | undefined;
      changes.catch((error: Error) => (failed = error));
      dc.holdPing = () => false;
      dc.releaseHeldPings();
      await vi.advanceTimersByTimeAsync(10);
      await flush();
      // Installed, but the sync barrier is still waiting on index.
      dc.close("closed during sync");
      await flush();
      expect(failed).toBeInstanceOf(DisconnectedError);
    } finally {
      remote.close();
    }
  });

  it("closes the active RTC peer when the controller closes", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      const dc = await upgrade(remote, world, network);
      expect(dc.isClosed).toBe(false);
      remote.close();
      expect(dc.isClosed).toBe(true);
    } finally {
      remote.close();
    }
  });

  it("counts several outstanding pongs and ignores only unknown ids", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const remote = await ready(connectRemoteDurable(options(network, world)));
    try {
      const dc = await upgrade(remote, world, network);
      const before = dc.pings.length;
      dc.holdPing = () => true;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dc.heldPings.length).toBeGreaterThanOrEqual(2);
      dc.releaseFirstHeldPing();
      await vi.advanceTimersByTimeAsync(10);
      expect(dc.pings.length).toBeGreaterThan(before + 1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(remote.rtcDiagnostics().path).toBe("p2p");
    } finally {
      remote.close();
    }
  });

  it("closes a failed signal attempt and retries after a network change", async () => {
    const world = new FakeRtcWorld();
    const network = wsNetwork({ rtcWorld: world });
    const signal = signalNetwork(world);
    const listeners: (() => void)[] = [];
    const base = options(network, world);
    const remote = await ready(connectRemoteDurable({
      ...base,
      network: { subscribe: (listener) => { listeners.push(listener); return () => undefined; } },
      candidates: [relay()],
      rtc: { ...base.rtc!, openSignalTransport: signal.transport },
    }));
    try {
      world.failCreate = "no peer";
      remote.setConnectionMode("directOnly");
      await flush();
      expect(signal.opens).toHaveLength(1);
      expect(remote.rtcDiagnostics().cooldownRemainingMs).toBeGreaterThan(0);
      listeners[0]!();
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(signal.opens.length).toBeGreaterThan(1);
    } finally {
      remote.close();
    }
  });
});
