// The WebRTC signaling shapes and the small SDP helpers both ends need.
// Kept in the protocol package because the host answers, the browser offers,
// and the native clients parse the same text; nothing here touches Node or
// the DOM.
//
// The host's answerer and the clients' offerers are non-trickle: every offer
// and answer carries the candidates that existed when it was sealed. A
// candidate that arrives later belongs to the next attempt, not to a live
// one.

/**
 * How reachable the address behind one ICE candidate is: the local machine,
 * the same LAN, the tailnet, or the public internet. Unknown covers mDNS
 * hostnames, absent addresses, and anything that does not parse as an IP.
 */
export type RtcAddressScope = "loopback" | "lan" | "tailnet" | "public" | "unknown";

/** The raw pair a platform reports; no classification, no assumptions. */
export interface RtcCandidateInfo {
  readonly type?: string;
  readonly address?: string;
}

export interface RtcCandidatePair {
  readonly local: RtcCandidateInfo;
  readonly remote: RtcCandidateInfo;
}

export interface RtcCandidateEnd extends RtcCandidateInfo {
  readonly scope: RtcAddressScope;
}

export interface RtcSelectedPair {
  readonly local: RtcCandidateEnd;
  readonly remote: RtcCandidateEnd;
}

/**
 * Classify the address behind a platform candidate. The address may carry a
 * port, an IPv6 zone, or brackets; mDNS names and malformed values are
 * "unknown" because the UI must not guess a route.
 */
export function rtcAddressScope(address: string | undefined): RtcAddressScope {
  const ip = parseRtcAddress(address);
  if (ip === undefined) return "unknown";
  if (ip.family === 4) return ipv4Scope(ip.octets);
  const octets = mappedIpv4(ip.segments);
  return octets === undefined ? ipv6Scope(ip.segments) : ipv4Scope(octets);
}

export function rtcCandidateEnd(info: RtcCandidateInfo): RtcCandidateEnd {
  return {
    ...(info.type === undefined ? {} : { type: info.type }),
    ...(info.address === undefined ? {} : { address: info.address }),
    scope: rtcAddressScope(info.address),
  };
}

export function rtcSelectedPair(local: RtcCandidateInfo, remote: RtcCandidateInfo): RtcSelectedPair {
  return { local: rtcCandidateEnd(local), remote: rtcCandidateEnd(remote) };
}

type ParsedAddress =
  | { readonly family: 4; readonly octets: readonly number[] }
  | { readonly family: 6; readonly segments: readonly number[] };

function parseRtcAddress(address: string | undefined): ParsedAddress | undefined {
  if (address === undefined) return undefined;
  const text = address.trim();
  if (text === "") return undefined;
  let host = text;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return undefined;
    const tail = text.slice(close + 1);
    if (tail !== "" && !/^:\d+$/.test(tail)) return undefined;
    host = text.slice(1, close);
  } else if (text.split(":").length === 2) {
    const [candidate, port] = text.split(":") as [string, string];
    if (/^\d+$/.test(port)) host = candidate;
  }
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) return { family: 4, octets: ipv4 };
  const ipv6 = parseIpv6(host);
  return ipv6 === undefined ? undefined : { family: 6, segments: ipv6 };
}

function parseIpv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function parseIpv6(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (part: string, allowIpv4: boolean): number[] | undefined => {
    if (part === "") return [];
    const tokens = part.split(":");
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (allowIpv4 && index === tokens.length - 1 && token.includes(".")) {
        const v4 = parseIpv4(token);
        if (v4 === undefined) return undefined;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return undefined;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };
  if (halves.length === 1) {
    const groups = parsePart(text, true);
    return groups?.length === 8 ? groups : undefined;
  }
  const left = parsePart(halves[0]!, false);
  const right = parsePart(halves[1]!, true);
  if (left === undefined || right === undefined) return undefined;
  const zeros = 8 - left.length - right.length;
  if (zeros < 1) return undefined;
  return [...left, ...new Array<number>(zeros).fill(0), ...right];
}

function mappedIpv4(segments: readonly number[]): number[] | undefined {
  if (!segments.slice(0, 5).every((group) => group === 0) || segments[5] !== 0xffff) return undefined;
  return [segments[6]! >> 8, segments[6]! & 0xff, segments[7]! >> 8, segments[7]! & 0xff];
}

function ipv4Scope(octets: readonly number[]): RtcAddressScope {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return "lan";
  }
  return "public";
}

function ipv6Scope(segments: readonly number[]): RtcAddressScope {
  if (segments[0] === 0xfd7a && segments[1] === 0x115c && segments[2] === 0xa1e0) return "tailnet";
  if ((segments[0]! & 0xfe00) === 0xfc00 || (segments[0]! & 0xffc0) === 0xfe80) return "lan";
  if (segments.slice(0, 7).every((group) => group === 0) && segments[7] === 1) return "loopback";
  return "public";
}

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
