// Test-only helpers for the host's RTC path (ADR-0033): a raw secure
// WebSocket client that speaks the gateway frames without the coordinator, and
// a node-datachannel offerer that runs the same Noise IK over its DataChannel.
import { once } from "node:events";
import ndc, { type DataChannel, type PeerConnection } from "node-datachannel";
import { WebSocket } from "ws";
import type { CallMethod, CallMethods, ClientFrame, ServerFrame } from "@pinomad/protocol/frames.ts";
import { initiateIK, type KeyPair } from "@pinomad/protocol/noise.ts";
import {
  decodeHostHello,
  encodeClientHello,
  SECURE_PROLOGUE,
  SecureSession,
  type ClientHello,
} from "@pinomad/protocol/secure-channel.ts";
import {
  RTC_DATA_CHANNEL_LABEL,
  sdpCandidates,
  withRtcCandidates,
} from "@pinomad/protocol/rtc.ts";

const DEFAULT_FRAME_TIMEOUT_MS = 30_000;

export class FramePump {
  readonly ik: ReturnType<typeof initiateIK>;
  readonly handshakeDone: Promise<void>;
  #resolveHandshake!: () => void;
  #rejectHandshake!: (error: Error) => void;
  #session: SecureSession | undefined;
  readonly #frames: ServerFrame[] = [];
  readonly #waiters: {
    predicate: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(hostKey: Uint8Array, device: KeyPair, prologue: Uint8Array) {
    this.ik = initiateIK({ prologue, static: device, remoteStatic: hostKey });
    this.handshakeDone = new Promise<void>((resolve, reject) => {
      this.#resolveHandshake = resolve;
      this.#rejectHandshake = reject;
    });
    this.handshakeDone.catch(() => {});
  }

  message1(payload: Uint8Array): Uint8Array {
    return this.ik.writeMessage1(payload);
  }

  feed(bytes: Uint8Array): void {
    if (this.#session === undefined) {
      try {
        const { payload, result } = this.ik.readMessage2(bytes);
        decodeHostHello(payload);
        this.#session = new SecureSession(result);
        this.#resolveHandshake();
      } catch (error) {
        this.#rejectHandshake(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    try {
      const text = this.#session.open(bytes);
      if (text !== undefined) this.#push(JSON.parse(text) as ServerFrame);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  seal(text: string): Uint8Array[] {
    if (this.#session === undefined) throw new Error("secure session is not ready");
    return this.#session.seal(text);
  }

  nextFrame(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  ): Promise<ServerFrame> {
    const index = this.#frames.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.#frames.splice(index, 1)[0]!);
    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.#waiters.findIndex((waiter) => waiter.timer === timer);
        if (at !== -1) this.#waiters.splice(at, 1);
        reject(new Error("timed out waiting for a secure frame"));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close(error = new Error("secure client closed")): void {
    this.#rejectHandshake(error);
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #push(frame: ServerFrame): void {
    for (let index = 0; index < this.#waiters.length; index += 1) {
      const waiter = this.#waiters[index]!;
      if (!waiter.predicate(frame)) continue;
      this.#waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.#frames.push(frame);
  }
}

async function sendOnWebSocket(socket: WebSocket, records: readonly Uint8Array[]): Promise<void> {
  for (const record of records) {
    await new Promise<void>((resolve, reject) => {
      // ws passes null on success at runtime even though its types say undefined.
      socket.send(record, (error) => (error == null ? resolve() : reject(error)));
    });
  }
}

export interface RawSecureOptions {
  readonly url: string;
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  readonly prologue: Uint8Array;
  readonly pair?: { readonly secret: string; readonly name: string };
}

/** The business hello or the signal-only minimal hello (ADR-0033 §1). */
export type SecureHello = Extract<ServerFrame, { type: "hello" | "signalHello" }>;

/** A secure WebSocket that exposes hello/frames/calls without RemoteDurable. */
export class RawSecureClient {
  readonly pump: FramePump;
  readonly hello: SecureHello;
  readonly closed: Promise<number>;
  readonly #socket: WebSocket;
  #nextId = 1;

  private constructor(
    socket: WebSocket,
    pump: FramePump,
    hello: SecureHello,
    closed: Promise<number>,
  ) {
    this.#socket = socket;
    this.pump = pump;
    this.hello = hello;
    this.closed = closed;
  }

  static async open(options: RawSecureOptions): Promise<RawSecureClient> {
    const socket = new WebSocket(options.url);
    const pump = new FramePump(options.hostKey, options.device, options.prologue);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        pump.close(new Error("unexpected text frame on the secure channel"));
        socket.close();
        return;
      }
      const bytes = Array.isArray(data)
        ? new Uint8Array(Buffer.concat(data))
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      pump.feed(bytes);
    });
    socket.on("error", () => {});
    await once(socket, "open");
    const hello: ClientHello = options.pair === undefined ? { v: 1 } : { v: 1, pair: options.pair };
    socket.send(pump.message1(encodeClientHello(hello)));
    try {
      await Promise.race([
        pump.handshakeDone,
        closed.then(() => {
          throw new Error("the secure socket closed before its handshake");
        }),
      ]);
      const frame = await Promise.race([
        pump.nextFrame((candidate) => candidate.type === "hello" || candidate.type === "signalHello"),
        closed.then(() => {
          throw new Error("the secure socket closed before its hello");
        }),
      ]);
      return new RawSecureClient(socket, pump, frame as SecureHello, closed);
    } catch (error) {
      pump.close(error instanceof Error ? error : new Error(String(error)));
      socket.close();
      throw error;
    }
  }

  sendFrame(frame: ClientFrame): Promise<void> {
    return sendOnWebSocket(this.#socket, this.pump.seal(JSON.stringify(frame)));
  }

  async nextFrame(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  ): Promise<ServerFrame> {
    return await this.pump.nextFrame(predicate, timeoutMs);
  }

  async call<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
    const id = this.#nextId++;
    const result = this.nextFrame((frame) => frame.type === "result" && frame.id === id);
    await this.sendFrame({ type: "call", id, method, args } as ClientFrame);
    const frame = await result;
    if (frame.type !== "result") throw new Error("not a result");
    if (!frame.ok) throw new Error(frame.error);
    return frame.value as CallMethods[M]["result"];
  }

  close(): void {
    this.pump.close();
    this.#socket.close();
  }
}

export interface RtcDataOptions {
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  readonly stun: readonly string[];
}

/**
 * A client offerer over node-datachannel. The offer is non-trickle; after the
 * host's answer the DataChannel opens, Noise IK runs with the business
 * prologue, and the normal gateway frames ride the record layer.
 */
export class RtcDataPeer {
  readonly offerSdp: string;
  readonly pump: FramePump;
  readonly closed: Promise<void>;
  readonly #pc: PeerConnection;
  readonly #dc: DataChannel;
  #nextId = 1;
  #closed = false;
  #falseSends = 0;

  private constructor(pc: PeerConnection, dc: DataChannel, pump: FramePump, offerSdp: string, closed: Promise<void>) {
    this.#pc = pc;
    this.#dc = dc;
    this.pump = pump;
    this.offerSdp = offerSdp;
    this.closed = closed;
  }

  static async create(options: RtcDataOptions): Promise<RtcDataPeer> {
    const pc = new ndc.PeerConnection(`pinomad-test-${Math.random().toString(16).slice(2)}`, {
      iceServers: [...options.stun],
    });
    // node-datachannel only delivers onLocalDescription when the callback was
    // installed before createDataChannel; gatherOffer therefore creates the
    // channel after wiring its listeners.
    let gathered: { offerSdp: string; dc: DataChannel };
    try {
      gathered = await gatherOffer(pc, () => pc.createDataChannel(RTC_DATA_CHANNEL_LABEL));
    } catch (error) {
      try {
        pc.close();
      } catch {
        // already closed
      }
      throw error;
    }
    const dc = gathered.dc;
    const pump = new FramePump(options.hostKey, options.device, SECURE_PROLOGUE);
    const closed = new Promise<void>((resolve) => dc.onClosed(() => resolve()));
    dc.onMessage((message) => {
      if (typeof message === "string") {
        pump.close(new Error("unexpected text record on the DataChannel"));
        return;
      }
      pump.feed(
        message instanceof ArrayBuffer
          ? new Uint8Array(message)
          : new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
      );
    });
    dc.onError(() => pump.close(new Error("DataChannel error")));

    return new RtcDataPeer(pc, dc, pump, gathered.offerSdp, closed);
  }

  /** Set the host's answer, wait for the DataChannel, and complete Noise. */
  async accept(answerSdp: string): Promise<Extract<ServerFrame, { type: "hello" }>> {
    // node-datachannel has no EventEmitter API: wire the callback before setting
    // the remote description, and keep a promise the caller can await.
    const open = new Promise<void>((resolve) => {
      this.#dc.onOpen(resolve);
      if (this.#dc.isOpen()) resolve();
    });
    try {
      this.#pc.setRemoteDescription(answerSdp, "answer");
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    await Promise.race([
      open,
      this.closed.then(() => {
        throw new Error("the DataChannel closed before it opened");
      }),
      timeout("DataChannel open timeout", 20_000),
    ]);
    await this.sendRecords([this.pump.message1(encodeClientHello({ v: 1 }))]);
    await Promise.race([
      this.pump.handshakeDone,
      timeout("Noise message 2 timeout", 20_000),
    ]);
    const frame = await this.pump.nextFrame((candidate) => candidate.type === "hello");
    return frame as Extract<ServerFrame, { type: "hello" }>;
  }

  async sendRecords(records: readonly Uint8Array[]): Promise<void> {
    for (const record of records) {
      while (this.#dc.bufferedAmount() >= 256 * 1024) await this.#lowWater();
      // false means "queued" in libdatachannel; it still counts as sent.
      if (this.#dc.sendMessageBinary(record) === false) this.#falseSends += 1;
    }
  }

  async sendFrame(frame: ClientFrame): Promise<void> {
    await this.sendRecords(this.pump.seal(JSON.stringify(frame)));
  }

  async nextFrame(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  ): Promise<ServerFrame> {
    return await this.pump.nextFrame(predicate, timeoutMs);
  }

  async call<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
    const id = this.#nextId++;
    const result = this.nextFrame((frame) => frame.type === "result" && frame.id === id);
    await this.sendFrame({ type: "call", id, method, args } as ClientFrame);
    const frame = await result;
    if (frame.type !== "result") throw new Error("not a result");
    if (!frame.ok) throw new Error(frame.error);
    return frame.value as CallMethods[M]["result"];
  }

  get falseSends(): number {
    return this.#falseSends;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.pump.close();
    try {
      this.#dc.close();
    } catch {
      // already closed
    }
    try {
      this.#pc.close();
    } catch {
      // already closed
    }
  }

  async #lowWater(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DataChannel low-water timeout")), 15_000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.#dc.onBufferedAmountLow(done);
      // The event may have fired between the check and the registration.
      if (this.#dc.bufferedAmount() < 256 * 1024) done();
    });
  }
}

function timeout(message: string, ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

async function gatherOffer(
  pc: PeerConnection,
  makeChannel: () => DataChannel,
): Promise<{ offerSdp: string; dc: DataChannel }> {
  const candidates = new Set<string>();
  let localSdp: string | undefined;
  let gatheringDone = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveOffer!: (sdp: string) => void;
  let rejectOffer!: (error: Error) => void;
  const offer = new Promise<string>((resolve, reject) => {
    resolveOffer = resolve;
    rejectOffer = reject;
  });
  offer.catch(() => {});

  const add = (raw: string): void => {
    const parts = raw.trim().split(/\s+/);
    const type = parts[parts.indexOf("typ") + 1];
    if (type === "host" || type === "srflx" || type === "prflx") {
      candidates.add(raw.startsWith("a=") ? raw.slice(2) : raw);
    }
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    rejectOffer(error);
  };
  const commit = (): void => {
    if (settled || localSdp === undefined) return;
    for (const candidate of sdpCandidates(localSdp)) add(candidate);
    if (candidates.size === 0) {
      fail(new Error("the offer gathered no usable candidates"));
      return;
    }
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveOffer(withRtcCandidates(localSdp, [...candidates]));
  };

  pc.onLocalDescription((sdp) => {
    localSdp = sdp;
    if (gatheringDone) commit();
  });
  pc.onLocalCandidate((candidate) => add(candidate));
  pc.onGatheringStateChange((state) => {
    if (state === "complete") {
      gatheringDone = true;
      commit();
    }
  });
  const dc = makeChannel();
  pc.setLocalDescription("offer");
  timer = setTimeout(() => fail(new Error("ICE gathering did not complete")), 10_000);
  return { offerSdp: await offer, dc };
}
