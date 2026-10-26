// The platform seam for WebRTC carriers and the shared record pump every
// adapter feeds. The platform owns PeerConnection/DataChannel semantics; this
// file owns the parts the protocol promises across libraries: the non-trickle
// offer, the Noise IK handshake over the DataChannel, one FIFO of records,
// backpressure and the stall deadline (ADR-0033 §2).
import { initiateIK, type KeyPair } from "./noise.ts";
import { RTC_DATA_CHANNEL_LABEL, parseRtcMaxMessageSize } from "./rtc.ts";
import {
  decodeHostHello,
  encodeClientHello,
  SECURE_PROLOGUE,
  SecureSession,
} from "./secure-channel.ts";
import type { FrameConnection, FrameHandlers, FrameTransport } from "./transport.ts";

/** Queue at which the pump stops handing records to the library. */
export const RTC_HIGH_WATER_BYTES = 256 * 1024;
/** The platform's low-water callback resumes the pump; the contract is not exact. */
export const RTC_LOW_WATER_BYTES = 64 * 1024;
/** No record accepted for this long closes the carrier; queue size alone never does. */
export const RTC_STALL_MS = 10_000;
/** The platform's own non-trickle candidate collection window. */
export const RTC_GATHER_MS = 2_000;

/**
 * What the library did with one record. This is deliberately three-valued:
 * node-datachannel's `false` means the record is already in the SCTP queue
 * (never resend it), while str0m's `false` means it was not accepted (retry
 * the same ciphertext later). The adapter maps its library, the shared pump
 * never guesses.
 */
export type RtcSendOutcome = "accepted" | "queued" | "rejected";

/** A reliable, ordered DataChannel as the platform exposes it. */
export interface RtcDataChannel {
  send(record: Uint8Array): RtcSendOutcome;
  readonly bufferedAmount: number;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (record: Uint8Array) => void): void;
  onClosed(listener: (reason?: string) => void): void;
  onBufferedAmountLow(listener: () => void): void;
}

/** One offered Peer: the gathered offer and the DataChannel it will open. */
export interface RtcPeer {
  /** The complete, non-trickle offer SDP after the platform's collection window. */
  readonly offerSdp: string;
  /** Apply the host's complete answer and start ICE. */
  acceptAnswer(sdp: string): void;
  readonly channel: RtcDataChannel;
  /** The selected ICE pair's candidate type, when the platform can report it. */
  selectedCandidateType?(): string | undefined;
  close(): void;
}

/** What a platform injects when it can create Peers (browser, desktop, tests). */
export interface RtcPlatform {
  /** Create the offer and its DataChannel; gather candidates within `RTC_GATHER_MS`. */
  createPeer(stun: readonly string[]): Promise<RtcPeer>;
}

export interface RtcClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const SYSTEM_RTC_CLOCK: RtcClock = {
  now: () => (typeof performance === "undefined" ? Date.now() : performance.now()),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface RtcTransportOptions {
  readonly platform: RtcPlatform;
  readonly stun: readonly string[];
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  /** Ask the host to answer this offer over the signaling connection. */
  offer(sdp: string): Promise<string>;
  /** Defaults to the business prologue; a signal path passes SIGNAL_PROLOGUE. */
  readonly prologue?: Uint8Array;
  readonly onCandidateType?: (type: string | undefined) => void;
  readonly clock?: RtcClock;
  readonly stallMs?: number;
}

/**
 * A FrameTransport over a platform RTC Peer. `signaled` fires when the host's
 * answer is applied (signal phase done), `opened` when the DataChannel is
 * open (ICE phase done), and `authenticated` when Noise message 2 verifies
 * (Noise phase done). A carrier-level failure is always close 1006: a
 * DataChannel has no authorization verdict and must never become a 4401.
 */
export function rtcTransport(options: RtcTransportOptions): FrameTransport {
  return {
    label: `webrtc:${RTC_DATA_CHANNEL_LABEL}`,
    open(handlers: FrameHandlers): FrameConnection {
      const clock = options.clock ?? SYSTEM_RTC_CLOCK;
      const stallMs = options.stallMs ?? RTC_STALL_MS;
      const prologue = options.prologue ?? SECURE_PROLOGUE;
      const ik = initiateIK({ prologue, static: options.device, remoteStatic: options.hostKey });
      const frames: string[] = [];
      const records: Uint8Array[] = [];
      let peer: RtcPeer | undefined;
      let channel: RtcDataChannel | undefined;
      let session: SecureSession | undefined;
      let opened = false;
      let closed = false;
      let lastProgress = clock.now();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let handshakeStarted = false;

      const clearStall = (): void => {
        if (stallTimer !== undefined) clock.clearTimeout(stallTimer);
        stallTimer = undefined;
      };
      const clearRetry = (): void => {
        if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
        retryTimer = undefined;
      };
      const fail = (reason: string): void => {
        if (closed) return;
        closed = true;
        clearStall();
        clearRetry();
        try {
          peer?.close();
        } catch {
          // Closing a failed Peer is best effort; the close verdict is ours.
        }
        handlers.closed(1006, reason);
      };
      const armStall = (): void => {
        if (closed || records.length === 0 || stallTimer !== undefined) return;
        stallTimer = clock.setTimeout(() => {
          stallTimer = undefined;
          if (closed) return;
          if (records.length === 0) return;
          if (clock.now() - lastProgress < stallMs) {
            armStall();
            return;
          }
          fail(`the DataChannel made no progress for ${stallMs}ms`);
        }, stallMs);
      };

      const pump = (): void => {
        if (closed || channel === undefined) return;
        if (records.length === 0) {
          clearStall();
          clearRetry();
          return;
        }
        if (channel.bufferedAmount >= RTC_HIGH_WATER_BYTES) return;
        let outcome: RtcSendOutcome;
        try {
          outcome = channel.send(records[0]!);
        } catch (error) {
          fail(error instanceof Error ? error.message : "the DataChannel send failed");
          return;
        }
        if (outcome === "rejected") {
          // The library did not take the record; the same ciphertext is
          // retried after the next low-water callback (or a bounded poll).
          if (retryTimer === undefined) {
            retryTimer = clock.setTimeout(() => {
              retryTimer = undefined;
              pump();
            }, 50);
          }
          return;
        }
        clearRetry();
        records.shift();
        lastProgress = clock.now();
        armStall();
        queueMicrotask(pump);
      };

      const enqueue = (next: readonly Uint8Array[]): void => {
        if (closed || next.length === 0) return;
        records.push(...next);
        lastProgress = clock.now();
        armStall();
        pump();
      };

      const sealFrames = (): void => {
        if (session === undefined) return;
        for (const text of frames.splice(0)) enqueue(session.seal(text));
      };

      const receive = (bytes: Uint8Array): void => {
        if (closed) return;
        try {
          if (session === undefined) {
            const { payload, result } = ik.readMessage2(bytes);
            decodeHostHello(payload);
            session = new SecureSession(result);
            handlers.authenticated?.();
            sealFrames();
            return;
          }
          const text = session.open(bytes);
          if (text !== undefined) handlers.message(text);
        } catch (error) {
          fail(error instanceof Error ? error.message : "secure DataChannel failure");
        }
      };

      void options.platform.createPeer(options.stun).then(
        (created) => {
          if (closed) {
            created.close();
            return;
          }
          peer = created;
          channel = created.channel;
          channel.onOpen(() => {
            if (closed || opened) return;
            opened = true;
            options.onCandidateType?.(created.selectedCandidateType?.());
            handlers.opened?.();
            if (!handshakeStarted) {
              handshakeStarted = true;
              enqueue([ik.writeMessage1(encodeClientHello({ v: 1 }))]);
            }
          });
          channel.onMessage(receive);
          channel.onClosed((reason) => {
            if (!closed) fail(reason === undefined ? "the DataChannel closed" : `the DataChannel closed: ${reason}`);
          });
          channel.onBufferedAmountLow(pump);
          let answer: string;
          return options.offer(created.offerSdp).then((sdp) => {
            if (closed) return;
            const limit = parseRtcMaxMessageSize(sdp);
            if (limit.kind === "invalid") throw new Error(limit.reason);
            answer = sdp;
            created.acceptAnswer(answer);
            handlers.signaled?.();
          });
        },
        (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
      ).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

      return {
        send(text: string): void {
          if (closed) return;
          if (session === undefined) {
            frames.push(text);
            return;
          }
          enqueue(session.seal(text));
        },
        close(): void {
          if (closed) return;
          closed = true;
          clearStall();
          clearRetry();
          try {
            peer?.close();
          } catch {
            // Already gone.
          }
        },
      };
    },
  };
}
