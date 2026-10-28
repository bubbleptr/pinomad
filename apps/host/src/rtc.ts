// The host side of WebRTC (ADR-0033): node-datachannel is loaded lazily so a
// host installed with --omit=optional still starts, answers offers, and runs
// its business gateway without hello.rtc.
//
// The hard-won semantics from PR0 (#345) are load-bearing here:
// - sendMessageBinary() returning false means "queued", not "rejected"; the
//   record counts as sent and is never retried, or the Noise nonce sequence
//   breaks;
// - backpressure is bufferedAmount() + onBufferedAmountLow, with a fallback
//   poll only for a missed callback, never for a retry;
// - a carrier is closed only after 10 s without any pump progress, never
//   because the queue is large.
import { randomUUID } from "node:crypto";
import {
  RTC_DATA_CHANNEL_LABEL,
  RTC_MAX_RECORD_BYTES,
  parseRtcMaxMessageSize,
  rtcCandidateType,
  sdpCandidates,
  withRtcCandidates,
  type RtcAnswer,
  type RtcHello,
} from "@pinomad/protocol/rtc.ts";
import type { CarrierHandlers, RecordCarrier } from "./secure-carrier.ts";

/** Backpressure bounds measured in PR0: 256 KiB high, 64 KiB low. */
const BUFFER_HIGH_WATER = 256 * 1024;
const BUFFER_LOW_WATER = 64 * 1024;
/** Only a stall — no record handed to the transport at all — closes a peer. */
const PUMP_STALL_MS = 10_000;
const FALLBACK_POLL_MS = 50;
const CANDIDATE_BUDGET_MS = 2_000;
const PEER_TIMEOUT_MS = 20_000;
const PER_DEVICE_PEERS = 2;
const HOST_PEERS = 8;

export interface RtcTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const systemRtcTimers: RtcTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface RtcPeerChannel {
  readonly carrier: RecordCarrier;
}

/** One PeerConnection: its answer SDP and a close lever. */
export interface RtcPeerConnection {
  /** Resolves with the complete (non-trickle) answer, or rejects. */
  readonly answer: Promise<string>;
  close(): void;
}

export interface RtcConnectInput {
  readonly offerSdp: string;
  readonly stun: readonly string[];
  readonly timers: RtcTimers;
  readonly onChannel: (channel: RtcPeerChannel) => void;
  readonly onClosed: () => void;
  readonly log: (event: string, detail?: Record<string, unknown>) => void;
}

/** The seam between Peer lifecycle and node-datachannel; tests use a fake. */
export interface RtcPeerFactory {
  connect(input: RtcConnectInput): RtcPeerConnection;
}

/** What the gateway may do with a peer while it is still finding its channel. */
export interface RtcPeerHandle {
  readonly attempt: string;
  readonly deviceKey?: string;
  /** Noise completed on the DataChannel: the peer now belongs to that connection. */
  handOff(): void;
}

export interface RtcOfferInput {
  /** The authenticated connection that asked; only its incomplete peers close with it. */
  readonly owner: object;
  readonly deviceKey?: string;
  readonly attempt: string;
  readonly sdp: string;
}

export interface RtcHost {
  /** The capability to put in a business or signal hello, re-read per hello. */
  hello(): RtcHello;
  offer(input: RtcOfferInput): Promise<RtcAnswer>;
  /** Close the peers this connection owns and has not handed off. */
  closeOwner(owner: object): void;
  /** Revocation: close every peer of this device that has not handed off. */
  closeDevice(deviceKey: string): void;
  close(): Promise<void>;
}

export interface StartRtcOptions {
  /** The current STUN list from settings.json, read on every offer and hello. */
  readonly stun: () => readonly string[];
  readonly onChannel: (peer: RtcPeerHandle, channel: RtcPeerChannel) => void;
  /** Test seam: throw to simulate a missing native module. */
  readonly load?: () => Promise<unknown>;
  /** Test seam: bypass node-datachannel entirely. */
  readonly factory?: RtcPeerFactory;
  readonly timers?: RtcTimers;
  readonly peerTimeoutMs?: number;
  readonly perDeviceLimit?: number;
  readonly hostLimit?: number;
  readonly diagnostic?: (message: string) => void;
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
}

/** The host-supplied part of the RTC setup; the gateway adds STUN and the channel handoff. */
export type RtcOptions = Omit<StartRtcOptions, "stun" | "onChannel">;

/** The platform prebuild npm would have installed for this host. */
export function platformPackageName(platform = process.platform, arch = process.arch): string {
  if (platform === "linux" && arch === "x64") return "@node-datachannel/linux-x64-gnu";
  if (platform === "linux" && arch === "arm64") return "@node-datachannel/linux-arm64-gnu";
  if (platform === "darwin" && arch === "arm64") return "@node-datachannel/darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@node-datachannel/darwin-x64";
  if (platform === "win32" && arch === "x64") return "@node-datachannel/win32-x64-msvc";
  if (platform === "win32" && arch === "arm64") return "@node-datachannel/win32-arm64-msvc";
  if (platform === "android" && arch === "arm64") return "@node-datachannel/android-arm64";
  return `@node-datachannel/${platform}-${arch}`;
}

/**
 * The one diagnostic a host without the native module prints. It names the
 * prebuild npm omitted, so "RTC is off" does not become an unexplained
 * missing feature (ADR-0033 §5).
 */
export function rtcUnavailableDiagnostic(
  error: unknown,
  platform = process.platform,
  arch = process.arch,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `RTC unavailable: cannot load node-datachannel on ${platform} (${arch}); `
    + `missing ${platformPackageName(platform, arch)}. `
    + "Install without --omit=optional (or build node-datachannel locally); "
    + "the host continues without hello.rtc. "
    + `(${detail})`
  );
}

export async function startRtcHost(options: StartRtcOptions): Promise<RtcHost | undefined> {
  let factory = options.factory;
  if (factory === undefined) {
    let loaded: unknown;
    try {
      loaded = options.load === undefined ? await import("node-datachannel") : await options.load();
    } catch (error) {
      (options.diagnostic ?? console.error)(rtcUnavailableDiagnostic(error));
      return undefined;
    }
    try {
      factory = nodeRtcFactory(loaded);
    } catch (error) {
      (options.diagnostic ?? console.error)(rtcUnavailableDiagnostic(error));
      return undefined;
    }
  }
  return new PeerHost(factory, options);
}

class PeerHost implements RtcHost {
  readonly #factory: RtcPeerFactory;
  readonly #options: StartRtcOptions;
  readonly #timers: RtcTimers;
  readonly #peers = new Set<ManagedPeer>();
  readonly #byAttempt = new Map<string, ManagedPeer>();
  readonly #log: (event: string, detail?: Record<string, unknown>) => void;

  constructor(factory: RtcPeerFactory, options: StartRtcOptions) {
    this.#factory = factory;
    this.#options = options;
    this.#timers = options.timers ?? systemRtcTimers;
    this.#log = options.log ?? (() => {});
  }

  hello(): RtcHello {
    return { stun: [...this.#options.stun()], signalOnly: true };
  }

  async offer(input: RtcOfferInput): Promise<RtcAnswer> {
    if (input.attempt === "") throw new Error("rtcOffer requires a non-empty attempt id");
    const stun = this.#options.stun();
    if (stun.length === 0) this.#log("rtc-no-stun", { attempt: input.attempt });
    const key = `${input.deviceKey ?? ""}\u0000${input.attempt}`;
    const existing = this.#byAttempt.get(key);
    if (existing !== undefined) {
      if (existing.answer !== undefined) return { sdp: existing.answer };
      if (existing.failure === undefined) {
        // A duplicate request shares the first answer, and also its timeout.
        return { sdp: await Promise.race([existing.answerPromise, existing.closedSignal]) };
      }
      existing.close();
    }

    const perDevice = this.#options.perDeviceLimit ?? PER_DEVICE_PEERS;
    const hostLimit = this.#options.hostLimit ?? HOST_PEERS;
    if (input.deviceKey !== undefined) {
      const count = [...this.#peers].filter((peer) => peer.deviceKey === input.deviceKey).length;
      if (count >= perDevice) {
        throw new Error(`Too many WebRTC peers for this device (limit ${perDevice})`);
      }
    }
    if (this.#peers.size >= hostLimit) {
      throw new Error(`Too many WebRTC peers on this host (limit ${hostLimit})`);
    }

    const peer = new ManagedPeer(this, {
      attempt: input.attempt,
      owner: input.owner,
      ...(input.deviceKey === undefined ? {} : { deviceKey: input.deviceKey }),
      timers: this.#timers,
    });
    this.#peers.add(peer);
    this.#byAttempt.set(key, peer);
    let connection: RtcPeerConnection;
    try {
      connection = this.#factory.connect({
        offerSdp: input.sdp,
        stun,
        timers: this.#timers,
        onChannel: (channel) => this.#onChannel(peer, channel),
        onClosed: () => this.#remove(peer),
        log: this.#log,
      });
    } catch (error) {
      this.#remove(peer);
      throw error;
    }
    peer.attach(connection);
    peer.answerPromise = connection.answer.then(
      (sdp) => {
        if (peer.closed) throw new Error("WebRTC peer closed before its answer was ready");
        peer.answer = sdp;
        return sdp;
      },
      (error: unknown) => {
        peer.failure = error instanceof Error ? error.message : String(error);
        this.#remove(peer);
        throw error;
      },
    );
    // The rejection is also observed by the caller below; this keeps an
    // unhandled rejection out of the process when the peer is swept first.
    peer.answerPromise.catch(() => {});
    peer.arm(this.#options.peerTimeoutMs ?? PEER_TIMEOUT_MS);
    // A timeout or an ICE failure closes the peer; the offer must fail then
    // instead of waiting on an answer that can no longer arrive.
    return { sdp: await Promise.race([peer.answerPromise, peer.closedSignal]) };
  }

  #onChannel(peer: ManagedPeer, channel: RtcPeerChannel): void {
    if (peer.closed) {
      channel.carrier.close(1008, "peer closed");
      return;
    }
    if (peer.channel !== undefined) {
      channel.carrier.close(1008, "duplicate DataChannel");
      return;
    }
    peer.channel = channel;
    this.#options.onChannel(peer, channel);
  }

  #remove(peer: ManagedPeer): void {
    if (!this.#peers.delete(peer)) return;
    for (const [key, candidate] of this.#byAttempt) {
      if (candidate === peer) this.#byAttempt.delete(key);
    }
    // Removal can come from the factory's close/error callback, not only from
    // peer.close(): the underlying PeerConnection and carrier still need to be
    // released (dureview P1). teardown is idempotent and does not re-enter the
    // manager.
    peer.teardown();
  }

  closeOwner(owner: object): void {
    for (const peer of [...this.#peers]) {
      if (peer.owner === owner && !peer.handedOff) peer.close();
    }
  }

  closeDevice(deviceKey: string): void {
    for (const peer of [...this.#peers]) {
      if (peer.deviceKey === deviceKey && !peer.handedOff) peer.close();
    }
  }

  async close(): Promise<void> {
    for (const peer of [...this.#peers]) peer.close();
  }

  /** Internal: the peer calls back after a stall/timeout close. */
  remove(peer: ManagedPeer): void {
    this.#remove(peer);
  }
}

class ManagedPeer implements RtcPeerHandle {
  readonly attempt: string;
  readonly deviceKey?: string;
  readonly owner: object;
  readonly timers: RtcTimers;
  answer?: string;
  answerPromise: Promise<string> = Promise.reject(new Error("peer has no connection"));
  readonly closedSignal: Promise<never>;
  failure?: string;
  channel?: RtcPeerChannel;
  handedOff = false;
  closed = false;
  #connection?: RtcPeerConnection;
  #timer?: unknown;
  #rejectClosed!: (error: Error) => void;
  readonly #host: PeerHost;

  constructor(
    host: PeerHost,
    input: {
      readonly attempt: string;
      readonly owner: object;
      readonly deviceKey?: string;
      readonly timers: RtcTimers;
    },
  ) {
    this.#host = host;
    this.attempt = input.attempt;
    this.owner = input.owner;
    this.deviceKey = input.deviceKey;
    this.timers = input.timers;
    this.answerPromise.catch(() => {});
    this.closedSignal = new Promise<never>((_, reject) => {
      this.#rejectClosed = reject;
    });
    this.closedSignal.catch(() => {});
  }

  attach(connection: RtcPeerConnection): void {
    this.#connection = connection;
  }

  arm(timeoutMs: number): void {
    if (this.closed) return;
    this.#timer = this.timers.setTimeout(() => {
      this.#timer = undefined;
      if (this.closed || this.handedOff) return;
      // A Peer that never completes Noise stops owning an ICE allocation; it
      // must not leave a half-open candidate forever (ADR-0033 §4).
      this.close();
    }, timeoutMs);
  }

  handOff(): void {
    if (this.closed) return;
    this.handedOff = true;
    if (this.#timer !== undefined) {
      this.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  close(): void {
    this.#host.remove(this);
  }

  /**
   * Release the native connection and carrier without touching the manager's
   * indexes. Called from #remove, which can be entered by a factory callback
   * or by close(); both paths must be safe to run twice.
   */
  teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.#timer !== undefined) {
      this.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#rejectClosed(new Error(this.failure ?? "WebRTC peer closed"));
    try {
      this.#connection?.close();
    } catch {
      // Closing an already-closed PeerConnection is not an error here.
    }
    this.channel?.carrier.close(1008, "peer closed");
  }
}

// ─── node-datachannel adapter ───────────────────────────────────────────────

interface NativeDataChannel {
  getLabel(): string;
  isOpen(): boolean;
  bufferedAmount(): number;
  maxMessageSize(): number;
  setBufferedAmountLowThreshold(value: number): void;
  sendMessageBinary(bytes: Uint8Array): boolean;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (error: string) => void): void;
  onBufferedAmountLow(cb: () => void): void;
  onMessage(cb: (message: string | ArrayBuffer | Uint8Array) => void): void;
}

interface NativePeerConnection {
  close(): void;
  setRemoteDescription(sdp: string, type: "offer"): void;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  localDescription(): { type: string; sdp: string } | null;
  onStateChange(cb: (state: string) => void): void;
  onGatheringStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (channel: NativeDataChannel) => void): void;
}

interface NativeModule {
  PeerConnection: new (name: string, config: { iceServers: readonly string[] }) => NativePeerConnection;
}

function nativeModule(loaded: unknown): NativeModule {
  const candidate = (loaded as { default?: unknown }).default ?? loaded;
  if (typeof (candidate as NativeModule).PeerConnection !== "function") {
    throw new Error("node-datachannel did not export PeerConnection");
  }
  return candidate as NativeModule;
}

/** The real adapter: Offer → answer SDP, then hand the DataChannel over. */
export function nodeRtcFactory(loaded: unknown): RtcPeerFactory {
  const ndc = nativeModule(loaded);
  return {
    connect(input) {
      // libdatachannel rejects an SDP it cannot parse; the Peer's answer
      // promise turns every such failure into rtcOffer's ok:false.
      const max = parseRtcMaxMessageSize(input.offerSdp);
      if (max.kind === "invalid") throw new Error(max.reason);

      const pc = new ndc.PeerConnection(`pinomad-${randomUUID()}`, { iceServers: [...input.stun] });
      const timers = input.timers;
      const candidates = new Set<string>();
      let localSdp: string | undefined;
      let gatheringDone = false;
      let deadlineReached = false;
      let settled = false;
      let deadline: unknown;
      let pollTimer: unknown;
      let commitTimer: unknown;
      let resolveAnswer!: (sdp: string) => void;
      let rejectAnswer!: (error: Error) => void;
      const answer = new Promise<string>((resolve, reject) => {
        resolveAnswer = resolve;
        rejectAnswer = reject;
      });
      answer.catch(() => {});

      const addCandidate = (raw: string): void => {
        const type = rtcCandidateType(raw);
        if (type !== "host" && type !== "srflx" && type !== "prflx") return;
        candidates.add(raw.startsWith("a=") ? raw.slice(2) : raw);
      };
      const stopTimers = (): void => {
        if (deadline !== undefined) {
          timers.clearTimeout(deadline);
          deadline = undefined;
        }
        if (pollTimer !== undefined) {
          timers.clearTimeout(pollTimer);
          pollTimer = undefined;
        }
        if (commitTimer !== undefined) {
          timers.clearTimeout(commitTimer);
          commitTimer = undefined;
        }
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        stopTimers();
        try {
          pc.close();
        } catch {
          // already closed
        }
        rejectAnswer(error);
      };
      const commit = (): void => {
        if (settled) return;
        // The native description is authoritative when it has already
        // gathered candidates that the queued callbacks have not delivered.
        const local = pc.localDescription();
        if (local !== null) localSdp = local.sdp;
        if (localSdp === undefined) return;
        for (const candidate of sdpCandidates(localSdp)) addCandidate(candidate);
        if (candidates.size === 0) {
          // libdatachannel reports "complete" on a native thread, while
          // node-datachannel queues that callback separately from the
          // candidate callbacks. Complete can therefore run before candidates
          // that were gathered earlier; only the collection deadline proves
          // the set is actually empty.
          if (deadlineReached) fail(new Error("no usable local ICE candidates"));
          return;
        }
        settled = true;
        stopTimers();
        resolveAnswer(withRtcCandidates(localSdp, [...candidates]));
      };
      const maybeCommit = (): void => {
        // A pending drain must run before sealing: the first late candidate
        // does not mean the other queued candidates have arrived.
        if (commitTimer !== undefined && !deadlineReached) return;
        if (localSdp !== undefined && (gatheringDone || deadlineReached)) commit();
      };
      const scheduleCommit = (): void => {
        if (settled) return;
        // Candidate and complete callbacks ride separate native-thread queues.
        // Yield one turn, and re-arm on each callback, so the answer is sealed
        // only after the callbacks already queued ahead of it have landed.
        if (commitTimer !== undefined) timers.clearTimeout(commitTimer);
        commitTimer = timers.setTimeout(() => {
          commitTimer = undefined;
          maybeCommit();
        }, 0);
      };

      pc.onLocalDescription((sdp) => {
        localSdp = sdp;
        if (gatheringDone) scheduleCommit();
        else maybeCommit();
      });
      pc.onLocalCandidate((candidate) => {
        addCandidate(candidate);
        if (gatheringDone) scheduleCommit();
      });
      pc.onGatheringStateChange((state) => {
        if (state === "complete") {
          gatheringDone = true;
          scheduleCommit();
        }
      });
      pc.onStateChange((state) => {
        if (state === "closed" || state === "failed") input.onClosed();
      });
      pc.onDataChannel((channel) => {
        // The offerer picks the label; anything else is not our carrier.
        if (channel.getLabel() !== RTC_DATA_CHANNEL_LABEL) {
          channel.close();
          return;
        }
        let delivered = false;
        const ready = (): void => {
          if (delivered || settled === false) return;
          delivered = true;
          const limit = channel.maxMessageSize();
          if (limit !== 0 && limit < RTC_MAX_RECORD_BYTES) {
            input.log("rtc-datachannel-too-small", { maxMessageSize: limit });
            channel.close();
            return;
          }
          input.onChannel({
            carrier: dataChannelCarrier(channel, timers, input.log, () => input.onClosed()),
          });
        };
        channel.onOpen(ready);
        if (channel.isOpen()) ready();
      });

      // A poll is the fallback for a missed callback, not the primary path:
      // localDescription() is populated synchronously by libdatachannel, but
      // its callbacks are delivered on a native thread and some embedders
      // (vitest's worker pool is one) never see them.
      const poll = (): void => {
        if (settled) return;
        const local = pc.localDescription();
        if (local !== null) {
          localSdp = local.sdp;
          if (gatheringDone) scheduleCommit();
          else maybeCommit();
        }
        if (!settled) pollTimer = timers.setTimeout(poll, 25);
      };
      pollTimer = timers.setTimeout(poll, 25);
      deadline = timers.setTimeout(() => {
        deadlineReached = true;
        const local = pc.localDescription();
        if (local !== null) localSdp = local.sdp;
        if (localSdp === undefined) fail(new Error(`no local description within ${CANDIDATE_BUDGET_MS} ms`));
        else commit();
      }, CANDIDATE_BUDGET_MS);

      try {
        pc.setRemoteDescription(input.offerSdp, "offer");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
      return {
        answer,
        close: () => {
          stopTimers();
          try {
            pc.close();
          } catch {
            // already closed
          }
        },
      };
    },
  };
}

/** A DataChannel carrier with the record FIFO and PR0's backpressure rules. */
export function dataChannelCarrier(
  channel: NativeDataChannel,
  timers: RtcTimers,
  log: (event: string, detail?: Record<string, unknown>) => void,
  /** The peer's own close notification; node-datachannel keeps one handler per event. */
  onClosed?: () => void,
): RecordCarrier {
  channel.setBufferedAmountLowThreshold(BUFFER_LOW_WATER);
  let handlers: CarrierHandlers | undefined;
  let closed = false;
  let pumping = false;
  let falseSends = 0;
  let lastProgress = timers.now();
  let pollTimer: unknown;
  let stallTimer: unknown;
  const queue: { bytes: Uint8Array; resolve: () => void }[] = [];

  const clearTimers = (): void => {
    if (pollTimer !== undefined) {
      timers.clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    if (stallTimer !== undefined) {
      timers.clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    for (const item of queue.splice(0)) item.resolve();
    handlers?.closed();
    onClosed?.();
  };
  const stall = (): void => {
    stallTimer = undefined;
    if (closed || queue.length === 0) return;
    if (timers.now() - lastProgress < PUMP_STALL_MS) {
      stallTimer = timers.setTimeout(stall, 1_000);
      return;
    }
    log("rtc-datachannel-stalled", { queued: queue.length, falseSends, buffered: channel.bufferedAmount() });
    finish();
    try {
      channel.close();
    } catch {
      // already closed
    }
  };

  const pump = (): void => {
    if (closed || pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !closed) {
        if (!channel.isOpen()) break;
        if (channel.bufferedAmount() >= BUFFER_HIGH_WATER) break;
        const item = queue[0]!;
        const max = channel.maxMessageSize();
        if (max !== 0 && item.bytes.length > max) {
          log("rtc-datachannel-record-too-large", { bytes: item.bytes.length, maxMessageSize: max });
          finish();
          try {
            channel.close();
          } catch {
            // already closed
          }
          return;
        }
        // false = libdatachannel queued the message, not a rejection. Advancing
        // is mandatory: retrying would duplicate the record and poison Noise.
        if (channel.sendMessageBinary(item.bytes) === false) falseSends += 1;
        queue.shift();
        item.resolve();
        lastProgress = timers.now();
      }
    } finally {
      pumping = false;
    }
    if (closed) return;
    if (queue.length === 0) {
      clearTimers();
      return;
    }
    if (pollTimer === undefined) {
      pollTimer = timers.setTimeout(() => {
        pollTimer = undefined;
        pump();
      }, FALLBACK_POLL_MS);
    }
    if (stallTimer === undefined) stallTimer = timers.setTimeout(stall, 1_000);
  };

  channel.onBufferedAmountLow(() => pump());
  channel.onMessage((message) => {
    if (typeof message === "string") handlers?.text();
    else if (message instanceof ArrayBuffer) handlers?.binary(new Uint8Array(message));
    else handlers?.binary(message);
  });
  channel.onClosed(finish);
  channel.onError((message) => {
    log("rtc-datachannel-error", { message });
    finish();
  });

  return {
    get open() {
      return !closed && channel.isOpen();
    },
    send(bytes) {
      if (closed || !channel.isOpen()) return Promise.resolve();
      return new Promise((resolve) => {
        queue.push({ bytes, resolve });
        pump();
      });
    },
    close(_code, _reason) {
      if (closed) return;
      finish();
      try {
        channel.close();
      } catch {
        // already closed
      }
    },
    handle(next) {
      handlers = next;
    },
  };
}

// Kept exported for the gateway's type-only use (and to make the timing
// constants reviewable in one place).
export const RTC_LIMITS = {
  candidatesMs: CANDIDATE_BUDGET_MS,
  peerTimeoutMs: PEER_TIMEOUT_MS,
  perDevice: PER_DEVICE_PEERS,
  host: HOST_PEERS,
} as const;
