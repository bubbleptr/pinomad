// Turning a host's published endpoints into the ordered candidates one
// connection round dials (ADR-0032). Pure and platform-neutral: the caller
// supplies the page protocol so an HTTPS page can report mixed-content
// candidates as unsupported instead of failing them as host outages.

import type { ConnectionMode } from "./connection-mode.ts";
import { isLoopbackUrl, type EndpointSet, type HostEndpoint } from "./endpoints.ts";

/** Why a candidate cannot be dialed at all; reported as a skipped path, not a host failure. */
export const MIXED_CONTENT_REASON = "mixed content: this HTTPS page blocks the insecure ws:// connection";

/** The path role a candidate plays for this client. */
export type RemoteCandidateRole = "loopback" | "relay" | "direct" | "legacy";

export interface RemoteCandidate {
  readonly url: string;
  readonly role: RemoteCandidateRole;
  /** Present when this platform cannot dial the candidate (for example mixed content). */
  readonly unsupported?: string;
}

export interface CandidatePlanOptions {
  /** The page's protocol, for example `window.location.protocol`. */
  readonly pageProtocol?: string;
}

/**
 * Business paths allowed by a connection mode (ADR-0033 §3):
 * Direct only keeps local plus direct WebSocket, Relay only keeps local plus
 * relay, and Auto keeps the existing order. A legacy URL has no role evidence;
 * it is treated as relay for Relay only and dropped for Direct only.
 */
export function filterCandidatesForMode(
  candidates: readonly RemoteCandidate[],
  mode: ConnectionMode,
): RemoteCandidate[] {
  if (mode === "auto") return [...candidates];
  if (mode === "relayOnly") {
    return candidates.filter((candidate) => candidate.role === "loopback" || candidate.role === "relay" || candidate.role === "legacy");
  }
  return candidates.filter((candidate) => candidate.role === "loopback" || candidate.role === "direct");
}

/**
 * The sockets a Direct-only client may use for a signal-only connection. Only
 * relay paths qualify: a working direct WebSocket is already a business path,
 * and P2P is the only way to turn a relay into business connectivity there.
 */
export function signalCandidates(candidates: readonly RemoteCandidate[]): RemoteCandidate[] {
  return candidates.filter((candidate) => candidate.role === "relay" || candidate.role === "legacy");
}

export const DIRECT_UNAVAILABLE =
  "Direct connection unavailable: this host cannot be reached without the relay and WebRTC did not connect.";

const isInsecureRemote = (url: string): boolean => {
  try {
    return new URL(url).protocol === "ws:" && !isLoopbackUrl(url);
  } catch {
    return false;
  }
};

const reasonFor = (url: string, options: CandidatePlanOptions): string | undefined =>
  options.pageProtocol === "https:" && isInsecureRemote(url) ? MIXED_CONTENT_REASON : undefined;

/**
 * The Auto order: a client-local loopback entry, then the host's relays in
 * published order, then its directs in published order.
 *
 * A usable endpoint set owns the remote candidates: a non-loopback legacy
 * `url` is not added when the set is present (including an explicit empty
 * set). Without a set the legacy `url` is the only remote candidate, kept for
 * old hosts and records. Identical urls are dialed once, first role wins.
 */
export function candidatePlan(
  legacyUrl: string,
  endpointSet: EndpointSet | undefined,
  options: CandidatePlanOptions = {},
): RemoteCandidate[] {
  const candidates: RemoteCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, role: RemoteCandidateRole): void => {
    if (seen.has(url)) return;
    seen.add(url);
    const unsupported = reasonFor(url, options);
    candidates.push({ url, role, ...(unsupported === undefined ? {} : { unsupported }) });
  };

  if (isLoopbackUrl(legacyUrl)) add(legacyUrl, "loopback");
  if (endpointSet !== undefined) {
    for (const endpoint of endpointSet.endpoints) if (endpoint.role === "relay") add(endpoint.url, "relay");
    for (const endpoint of endpointSet.endpoints) if (endpoint.role === "direct") add(endpoint.url, "direct");
  } else if (!isLoopbackUrl(legacyUrl)) {
    add(legacyUrl, "legacy");
  }
  return candidates;
}

const preferred = (endpoints: readonly HostEndpoint[], role: HostEndpoint["role"]): string | undefined =>
  endpoints.find((endpoint) => endpoint.role === role)?.url;

/**
 * The legacy `url` a stored host should carry while old clients still read it:
 * relay first, else the first direct. A loopback entry is client-local and
 * never changes; an empty remote set has no valid legacy expression, so the
 * old value stays and new clients trust the empty set.
 */
export function preferredLegacyUrl(currentUrl: string, endpointSet: EndpointSet): string {
  if (isLoopbackUrl(currentUrl)) return currentUrl;
  const relay = preferred(endpointSet.endpoints, "relay");
  if (relay !== undefined) return relay;
  return preferred(endpointSet.endpoints, "direct") ?? currentUrl;
}
