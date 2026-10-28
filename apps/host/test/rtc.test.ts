// The host's RTC answerer and signal-only path (ADR-0033). The real
// node-datachannel exchange lives in rtc-node.test.ts (a plain Node child:
// vitest's worker pool does not deliver the native thread callbacks). This
// file covers everything that does not need a real DataChannel, plus the
// deterministic Peer limits/timeouts through an injected factory and clock.
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import { generateKeyPair, initiateIK, respondIK } from "@pinomad/protocol/noise.ts";
import {
  encodeClientHello,
  fromBase64Url,
  SECURE_PROLOGUE,
  SIGNAL_PROLOGUE,
  toBase64Url,
} from "@pinomad/protocol/secure-channel.ts";
import {
  nodeRtcFactory,
  platformPackageName,
  startRtcHost,
  systemRtcTimers,
  type RtcPeerFactory,
  type RtcPeerConnection,
  type RtcTimers,
} from "../src/rtc.ts";
import type { RecordCarrier } from "../src/secure-carrier.ts";
import {
  connectTo,
  startFauxHost,
  useCleanups,
} from "./support.ts";
import { RawSecureClient } from "./rtc-support.ts";

const defer = useCleanups();

const SDP = "v=0\r\na=candidate:candidate:1 1 UDP 1 127.0.0.1 1234 typ host\r\n";

class FakeConnection implements RtcPeerConnection {
  readonly answer: Promise<string>;
  closed = false;
  readonly #onClosed: () => void;

  constructor(onClosed: () => void) {
    this.answer = Promise.resolve(SDP);
    this.#onClosed = onClosed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#onClosed();
  }

  /** Simulate a native close/error notification without closing the connection. */
  emitClosed(): void {
    this.#onClosed();
  }
}

class FakeFactory implements RtcPeerFactory {
  readonly connections: { input: Parameters<RtcPeerFactory["connect"]>[0]; connection: FakeConnection }[] = [];

  connect(input: Parameters<RtcPeerFactory["connect"]>[0]): RtcPeerConnection {
    const connection = new FakeConnection(() => input.onClosed());
    this.connections.push({ input, connection });
    return connection;
  }

  openChannel(index: number): void {
    const carrier: RecordCarrier = {
      open: true,
      send: async () => {},
      close: () => {},
      handle: () => {},
    };
    this.connections[index]!.input.onChannel({ carrier });
  }
}

class ManualRtcTimers implements RtcTimers {
  current = 0;
  #seq = 0;
  #queue: { id: number; at: number; fn: () => void }[] = [];

  now = (): number => this.current;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#queue.push({ id, at: this.current + ms, fn });
    this.#queue.sort((a, b) => a.at - b.at);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#queue = this.#queue.filter((entry) => entry.id !== handle);
  };

  advance(ms: number): void {
    const until = this.current + ms;
    for (;;) {
      const next = this.#queue.find((entry) => entry.at <= until);
      if (next === undefined) break;
      this.#queue.splice(this.#queue.indexOf(next), 1);
      this.current = next.at;
      next.fn();
    }
    this.current = until;
  }
}

interface PairingDetails {
  readonly hostKey: Uint8Array;
  readonly secret: string;
  readonly target: string;
}

function pairingDetails(url: string): PairingDetails {
  const params = new URLSearchParams(url.slice(url.indexOf("#") + 1));
  const pair = params.get("pair");
  const target = params.get("url");
  if (pair === null || target === null) throw new Error(`not a pairing link: ${url}`);
  const [key, secret] = pair.split(".");
  if (key === undefined || secret === undefined) throw new Error(`malformed pair field: ${pair}`);
  return { hostKey: fromBase64Url(key), secret, target };
}

async function pairAndSignal(token: Awaited<ReturnType<typeof connectTo>>) {
  const pairing = pairingDetails((await token.controller.createPairing()).url);
  const device = generateKeyPair();
  const business = await RawSecureClient.open({
    url: pairing.target,
    hostKey: pairing.hostKey,
    device,
    prologue: SECURE_PROLOGUE,
    pair: { secret: pairing.secret, name: "signal phone" },
  });
  defer(() => business.close());
  const signal = await RawSecureClient.open({
    url: pairing.target,
    hostKey: pairing.hostKey,
    device,
    prologue: SIGNAL_PROLOGUE,
  });
  defer(() => signal.close());
  return { pairing, device, business, signal };
}

describe("host RTC signal path", () => {
  it("sends a minimal hello and rejects business calls and subscriptions", async () => {
    const host = await startFauxHost(defer);
    const token = await connectTo(defer, host);
    const { signal } = await pairAndSignal(token);
    expect(signal.hello.type).toBe("signalHello");
    expect(signal.hello.protocol.minor).toBe(PROTOCOL.minor);
    expect(signal.hello.rtc).toBeDefined();
    expect("session" in signal.hello).toBe(false);
    expect("models" in signal.hello).toBe(false);
    expect("docs" in signal.hello).toBe(false);

    const ended = signal.nextFrame((frame) => frame.type === "ended");
    await signal.sendFrame({ type: "subscribe", stream: "conversations" });
    expect(await ended).toMatchObject({ type: "ended", reason: "Unsupported stream" });

    await expect(signal.call("createPairing", {})).rejects.toThrow("Unsupported method: createPairing");
    await expect(signal.call("revokeDevice", { publicKey: "A".repeat(43) })).rejects.toThrow(
      "Unsupported method: revokeDevice",
    );
    await expect(signal.call("ping", { id: "signal-ping" })).resolves.toEqual({ id: "signal-ping" });
  });

  it("reverts to a host without hello.rtc when the native module is missing", async () => {
    const diagnostics: string[] = [];
    const host = await startFauxHost(defer, {
      rtc: {
        load: async () => {
          throw new Error("simulated missing native module");
        },
        diagnostic: (line) => diagnostics.push(line),
      },
    });
    const raw = new WebSocket(`${host.url}?token=${encodeURIComponent(host.token)}`);
    defer(() => raw.close());
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      raw.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame.type === "hello") resolve(frame);
      });
      raw.on("error", reject);
    });
    expect(hello.rtc).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(platformPackageName());

    const client = await connectTo(defer, host);
    expect(client.view.current().connection).toBe("connected");
    await expect(client.controller.createPairing()).resolves.toHaveProperty("url");
  });

  it("a business-only responder rejects the signal prologue before anything registers", () => {
    const hostKey = generateKeyPair();
    const device = generateKeyPair();
    const oldHost = respondIK({ prologue: SECURE_PROLOGUE, static: hostKey });
    const initiator = initiateIK({
      prologue: SIGNAL_PROLOGUE,
      static: device,
      remoteStatic: hostKey.publicKey,
    });
    const message1 = initiator.writeMessage1(encodeClientHello({ v: 1 }));
    expect(() => oldHost.readMessage1(message1)).toThrow();
  });

  it("closes a business connection's incomplete peer when that connection disconnects", async () => {
    const factory = new FakeFactory();
    const host = await startFauxHost(defer, { rtc: { factory, peerTimeoutMs: 60_000 } });
    const token = await connectTo(defer, host);
    const { business } = await pairAndSignal(token);
    await expect(
      business.call("rtcOffer", { attempt: "business-close", sdp: SDP }),
    ).resolves.toEqual({ sdp: SDP });
    expect(factory.connections[0]!.connection.closed).toBe(false);

    business.close();
    await expect.poll(() => factory.connections[0]!.connection.closed).toBe(true);
  });

  it("closes the signal connection and the incomplete peer when the device is revoked", async () => {
    const factory = new FakeFactory();
    const host = await startFauxHost(defer, { rtc: { factory, peerTimeoutMs: 60_000 } });
    const token = await connectTo(defer, host);
    const { device, business, signal } = await pairAndSignal(token);

    await expect(
      signal.call("rtcOffer", { attempt: "pending-1", sdp: SDP }),
    ).resolves.toEqual({ sdp: SDP });
    expect(factory.connections).toHaveLength(1);
    expect(factory.connections[0]!.connection.closed).toBe(false);

    await token.controller.revokeDevice(toBase64Url(device.publicKey));
    expect(await signal.closed).toBe(4401);
    expect(await business.closed).toBe(4401);
    // The peer never completed Noise, so revocation owns it.
    expect(factory.connections[0]!.connection.closed).toBe(true);
  });
});

describe("Peer limits and timeouts", () => {
  async function rtcHost(overrides: { perDeviceLimit?: number; hostLimit?: number; peerTimeoutMs?: number } = {}) {
    const factory = new FakeFactory();
    const timers = new ManualRtcTimers();
    const channels: { peer: { handOff(): void }; carrier: RecordCarrier }[] = [];
    const host = await startRtcHost({
      factory,
      stun: () => [],
      timers,
      perDeviceLimit: overrides.perDeviceLimit ?? 2,
      hostLimit: overrides.hostLimit ?? 8,
      peerTimeoutMs: overrides.peerTimeoutMs ?? 20_000,
      onChannel: (peer, channel) => channels.push({ peer, carrier: channel.carrier }),
    });
    expect(host).toBeDefined();
    defer(() => host!.close());
    return { host: host!, factory, timers, channels };
  }

  const owner = {};

  it("answers a duplicate attempt without creating a second Peer", async () => {
    const { host, factory } = await rtcHost();
    const first = await host.offer({ owner, deviceKey: "d1", attempt: "same", sdp: SDP });
    const second = await host.offer({ owner, deviceKey: "d1", attempt: "same", sdp: SDP });
    expect(first).toEqual({ sdp: SDP });
    expect(second).toEqual(first);
    expect(factory.connections).toHaveLength(1);
  });

  it("enforces two peers per device and eight per host, and frees a slot on close", async () => {
    const { host, factory } = await rtcHost();
    for (let index = 0; index < 2; index += 1) {
      await host.offer({ owner, deviceKey: "d1", attempt: `d1-${index}`, sdp: SDP });
    }
    await expect(host.offer({ owner, deviceKey: "d1", attempt: "d1-2", sdp: SDP })).rejects.toThrow(
      "Too many WebRTC peers for this device (limit 2)",
    );
    for (const device of ["d2", "d3", "d4"]) {
      for (let index = 0; index < 2; index += 1) {
        await host.offer({ owner, deviceKey: device, attempt: `${device}-${index}`, sdp: SDP });
      }
    }
    await expect(host.offer({ owner, deviceKey: "d5", attempt: "d5-0", sdp: SDP })).rejects.toThrow(
      "Too many WebRTC peers on this host (limit 8)",
    );
    expect(factory.connections).toHaveLength(8);
    host.closeOwner(owner);
    expect(factory.connections.every(({ connection }) => connection.closed)).toBe(true);
    await expect(host.offer({ owner, deviceKey: "d5", attempt: "d5-0", sdp: SDP })).resolves.toEqual({ sdp: SDP });
  });

  it("releases the native connection when the factory reports the close", async () => {
    const { host, factory } = await rtcHost();
    await host.offer({ owner, deviceKey: "d1", attempt: "factory-close", sdp: SDP });
    // A real DataChannel close/error reaches the manager through the factory's
    // onClosed, not through closeOwner; the PeerConnection must still be freed.
    factory.connections[0]!.connection.emitClosed();
    expect(factory.connections[0]!.connection.closed).toBe(true);
    await expect(host.offer({ owner, deviceKey: "d1", attempt: "factory-close", sdp: SDP })).resolves.toEqual({
      sdp: SDP,
    });
    expect(factory.connections).toHaveLength(2);
  });

  it("closes a Peer that never completes Noise after the injected timeout", async () => {
    const { host, factory, timers } = await rtcHost({ peerTimeoutMs: 1_000 });
    await host.offer({ owner, deviceKey: "d1", attempt: "timeout", sdp: SDP });
    expect(factory.connections[0]!.connection.closed).toBe(false);
    timers.advance(1_000);
    expect(factory.connections[0]!.connection.closed).toBe(true);
    await expect(host.offer({ owner, deviceKey: "d1", attempt: "timeout", sdp: SDP })).resolves.toEqual({ sdp: SDP });
    expect(factory.connections).toHaveLength(2);
  });

  it("hands a completed Peer to its DataChannel, so its opener closing no longer owns it", async () => {
    const { host, factory, channels } = await rtcHost();
    await host.offer({ owner, deviceKey: "d1", attempt: "handoff", sdp: SDP });
    factory.openChannel(0);
    channels[0]!.peer.handOff();
    host.closeOwner(owner);
    expect(factory.connections[0]!.connection.closed).toBe(false);
    await host.close();
    expect(factory.connections[0]!.connection.closed).toBe(true);
  });
});

describe("node-datachannel answerer", () => {
  it("keeps candidates whose callbacks arrive after gathering completes", async () => {
    const candidate = "candidate:1 1 UDP 2122252543 127.0.0.1 40000 typ host";
    const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
      + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n"
      + "a=mid:0\r\na=sctp-port:5000\r\n";
    // libdatachannel reports "complete" from a native thread while
    // node-datachannel queues each callback separately. The complete callback
    // can therefore run before the candidate callbacks queued ahead of it.
    class ReorderedPeerConnection {
      #sdp: string | undefined;
      #localDescription?: (sdp: string, type: string) => void;
      #localCandidate?: (candidate: string, mid: string) => void;
      #gathering?: (state: string) => void;

      constructor(_name: string, _config: { iceServers: readonly string[] }) {}

      close(): void {}

      localDescription(): { type: string; sdp: string } | null {
        return this.#sdp === undefined ? null : { type: "answer", sdp: this.#sdp };
      }

      setRemoteDescription(): void {
        this.#sdp = "v=0\r\n";
        this.#localDescription?.(this.#sdp, "answer");
        this.#gathering?.("complete");
        queueMicrotask(() => {
          this.#sdp += `a=${candidate}\r\n`;
          this.#localCandidate?.(candidate, "0");
        });
      }

      onLocalDescription(cb: (sdp: string, type: string) => void): void {
        this.#localDescription = cb;
      }

      onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
        this.#localCandidate = cb;
      }

      onGatheringStateChange(cb: (state: string) => void): void {
        this.#gathering = cb;
      }

      onStateChange(_cb: (state: string) => void): void {}
      onDataChannel(_cb: (channel: unknown) => void): void {}
    }

    const factory = nodeRtcFactory({ PeerConnection: ReorderedPeerConnection });
    const answer = await factory.connect({
      offerSdp: offer,
      stun: [],
      timers: systemRtcTimers,
      onChannel: () => {
        throw new Error("the answerer should not open a DataChannel");
      },
      onClosed: () => {},
      log: () => {},
    }).answer;
    expect(answer).toContain(candidate);
  });
});
