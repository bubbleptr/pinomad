// The WebRTC signaling shapes and the small SDP helpers both ends need.
// Kept in the protocol package because the host answers, the browser offers,
// and the native clients parse the same text; nothing here touches Node or
// the DOM.
//
// The host's answerer and the clients' offerers are non-trickle: every offer
// and answer carries the candidates that existed when it was sealed. A
// candidate that arrives later belongs to the next attempt, not to a live
// one.

/** Where the host listens for ICE candidates when settings.json sets no list. */
export const RTC_DEFAULT_STUN: readonly string[] = ["stun:stun.cloudflare.com:3478"];

/** The single DataChannel label every PiNomad carrier opens. */
export const RTC_DATA_CHANNEL_LABEL = "pinomad";

/** The record layer never exceeds this; one record is one DataChannel message. */
export const RTC_MAX_RECORD_BYTES = 65535;

/** What an SDP without `a=max-message-size` promises (the browsers' default). */
export const RTC_DEFAULT_MAX_MESSAGE_SIZE = 65536;

/** The smallest peer-advertised limit that still carries one full record. */
export const RTC_MIN_MAX_MESSAGE_SIZE = RTC_MAX_RECORD_BYTES;

/**
 * The host's RTC capability in `hello.rtc`. `signalOnly: true` says the host
 * accepts a signal-only Noise connection, so a client may open one before it
 * has a business connection. The field is a literal so an older shape cannot
 * be mistaken for a capability.
 */
export interface RtcHello {
  readonly stun: readonly string[];
  readonly signalOnly: true;
}

export interface RtcOfferArgs {
  /** Client-chosen id for this attempt; duplicates answer idempotently. */
  readonly attempt: string;
  /** The offer SDP, candidates included. */
  readonly sdp: string;
}

export interface RtcAnswer {
  readonly sdp: string;
}

export function isRtcHello(value: unknown): value is RtcHello {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const hello = value as { stun?: unknown; signalOnly?: unknown };
  return (
    Array.isArray(hello.stun)
    && hello.stun.every((server) => typeof server === "string" && server.length > 0)
    && hello.signalOnly === true
  );
}

/** `typ` of an ICE candidate line, e.g. "host" in `candidate:... typ host ...`. */
export function rtcCandidateType(candidate: string): string | undefined {
  const parts = candidate.trim().split(/\s+/);
  const at = parts.indexOf("typ");
  return at === -1 ? undefined : parts[at + 1];
}

/** The raw `candidate:...` values an SDP carries. */
export function sdpCandidates(sdp: string): string[] {
  return sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:"))
    .map((line) => line.slice("a=".length));
}

/**
 * An SDP with exactly `candidates` and no trickle marker. The host must not
 * depend on the local description already carrying candidates: libdatachannel
 * often emits them after it, and a client that only reads the SDP would then
 * see none.
 */
export function withRtcCandidates(sdp: string, candidates: readonly string[]): string {
  const lines = sdp
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith("a=candidate:") && line !== "a=end-of-candidates");
  const unique = [...new Set(candidates.map((candidate) => candidate.replace(/^a=/, "")))];
  return [...lines, ...unique.map((candidate) => `a=${candidate}`), "a=end-of-candidates", ""].join("\r\n");
}

/**
 * The peer's SCTP send limit as its SDP advertises it. Absent means 65536 (the
 * browser default, enough for one 65535-byte record); 0 means unlimited (a
 * value Chrome itself treats as its own cap, not as mathematical infinity);
 * anything else must at least fit one record or the carrier cannot start.
 */
export type RtcMaxMessageSize =
  | { readonly kind: "bounded"; readonly bytes: number }
  | { readonly kind: "unlimited" }
  | { readonly kind: "invalid"; readonly reason: string };

export function parseRtcMaxMessageSize(sdp: string): RtcMaxMessageSize {
  const line = sdp.split(/\r?\n/).find((entry) => entry.startsWith("a=max-message-size:"));
  if (line === undefined) return { kind: "bounded", bytes: RTC_DEFAULT_MAX_MESSAGE_SIZE };
  const raw = line.slice("a=max-message-size:".length).trim();
  if (!/^\d+$/.test(raw)) return { kind: "invalid", reason: `malformed a=max-message-size: ${raw}` };
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes)) return { kind: "invalid", reason: `a=max-message-size is not a safe integer: ${raw}` };
  if (bytes === 0) return { kind: "unlimited" };
  if (bytes < RTC_MIN_MAX_MESSAGE_SIZE) {
    return { kind: "invalid", reason: `a=max-message-size ${bytes} cannot carry a ${RTC_MIN_MAX_MESSAGE_SIZE}-byte record` };
  }
  return { kind: "bounded", bytes };
}
