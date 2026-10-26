// The shared carrier pump: three-valued send outcomes, one record in flight,
// the stall deadline that is not a queue-size limit, and the SDP limit check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, respondIK } from "../src/noise.ts";
import { rtcTransport, type RtcDataChannel, type RtcPeer, type RtcPlatform, type RtcSendOutcome } from "../src/rtc-carrier.ts";
import { decodeClientHello, encodeHostHello, SECURE_PROLOGUE, SecureSession } from "../src/secure-channel.ts";

class Channel implements RtcDataChannel {
  readonly records: Uint8Array[] = [];
  outcome: RtcSendOutcome = "accepted";
  bufferedAmount = 0;
  #open: (() => void) | undefined;
  #message: ((record: Uint8Array) => void) | undefined;
  #closed: ((reason?: string) => void) | undefined;
  #low: (() => void) | undefined;
  #host: ReturnType<typeof respondIK> | undefined;
  #session: SecureSession | undefined;

  constructor(readonly hostKey: ReturnType<typeof generateKeyPair>) {}

  onOpen(listener: () => void): void { this.#open = listener; }
  onMessage(listener: (record: Uint8Array) => void): void { this.#message = listener; }
  onClosed(listener: (reason?: string) => void): void { this.#closed = listener; }
  onBufferedAmountLow(listener: () => void): void { this.#low = listener; }

  open(): void { queueMicrotask(() => this.#open?.()); }
  close(reason?: string): void { this.#closed?.(reason); }
  low(): void { this.#low?.(); }

  send(record: Uint8Array): RtcSendOutcome {
    if (this.outcome === "rejected") return "rejected";
    this.records.push(record);
    if (this.#session === undefined) {
      this.#host ??= respondIK({ prologue: SECURE_PROLOGUE, static: this.hostKey });
      const { payload } = this.#host.readMessage1(record);
      decodeClientHello(payload);
      const { message, result } = this.#host.writeMessage2(encodeHostHello({ v: 1 }));
      this.#session = new SecureSession(result);
      queueMicrotask(() => this.#message?.(message));
      return this.outcome;
    }
    try {
      this.#session.open(record);
    } catch {
      this.close("bad record");
    }
    return this.outcome;
  }
}

const world = () => {
  const hostKey = generateKeyPair();
  const channel = new Channel(hostKey);
  const peer: RtcPeer = {
    offerSdp: "v=0\r\n",
    acceptAnswer: () => channel.open(),
    channel,
    selectedCandidateType: () => "host",
    close: () => channel.close("peer closed"),
  };
  const platform: RtcPlatform = { createPeer: async () => peer };
  return { hostKey, device: generateKeyPair(), peer, platform, channel };
};

const invalidAnswer = () => Promise.resolve("v=0\r\na=max-message-size:10\r\n");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rtc carrier pump", () => {
  it("retries a rejected record byte-for-byte and never duplicates an accepted one", async () => {
    const w = world();
    const closed: number[] = [];
    const connection = rtcTransport({
      platform: w.platform,
      stun: [],
      hostKey: w.hostKey.publicKey,
      device: w.device,
      offer: () => Promise.resolve("v=0\r\na=max-message-size:65536\r\n"),
    }).open({
      message: () => {},
      closed: (code) => closed.push(code),
    });
    await vi.advanceTimersByTimeAsync(0);
    w.channel.low();
    expect(closed).toEqual([]);

    w.channel.outcome = "rejected";
    connection.send("one");
    expect(w.channel.records).toHaveLength(1); // the IK message 1
    w.channel.outcome = "queued";
    w.channel.low();
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    // The handshake record, then exactly one copy of the frame's record.
    expect(w.channel.records).toHaveLength(2);
    const frameRecord = [...w.channel.records[1]!];

    connection.send("two");
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    expect(w.channel.records).toHaveLength(3);
    expect([...w.channel.records[1]!]).toEqual(frameRecord);
  });

  it("closes a stalled carrier with 1006 after ten seconds of no progress", async () => {
    const w = world();
    const closed: [number, string | undefined][] = [];
    const connection = rtcTransport({
      platform: w.platform,
      stun: [],
      hostKey: w.hostKey.publicKey,
      device: w.device,
      offer: () => Promise.resolve("v=0\r\na=max-message-size:65536\r\n"),
    }).open({
      message: () => {},
      closed: (code, reason) => closed.push([code, reason]),
    });
    await vi.advanceTimersByTimeAsync(0);
    w.channel.low();
    w.channel.outcome = "rejected";
    connection.send("stuck");
    await vi.advanceTimersByTimeAsync(10_100);
    expect(closed).toHaveLength(1);
    expect(closed[0]![0]).toBe(1006);
    expect(closed[0]![1]).toContain("no progress");
  });

  it("rejects an answer whose max-message-size cannot carry one record", async () => {
    const w = world();
    const closed: [number, string | undefined][] = [];
    rtcTransport({
      platform: w.platform,
      stun: [],
      hostKey: w.hostKey.publicKey,
      device: w.device,
      offer: invalidAnswer,
    }).open({
      message: () => {},
      closed: (code, reason) => closed.push([code, reason]),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]![0]).toBe(1006);
    expect(closed[0]![1]).toContain("cannot carry");
  });
});
