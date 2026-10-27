// The diagnostics-to-copy mapping shared by the Path row, the address
// disclosure, and the Last failure row.
import type { ConnectionPath, P2PFailure, RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { RtcAddressScope, RtcCandidateEnd, RtcSelectedPair } from "@pinomad/protocol/rtc.ts";

export const PATH_LABEL: Record<ConnectionPath, string> = {
  p2p: "P2P",
  relay: "Relay",
  direct: "Direct",
  loopback: "Local",
};

const SCOPE_LABEL: Record<RtcAddressScope, string> = {
  loopback: "Local",
  lan: "LAN",
  tailnet: "Tailnet",
  public: "Internet",
  unknown: "Unknown",
};

const FAILURE_STAGE_LABEL: Record<P2PFailure["stage"], string> = {
  signal: "Signal",
  ice: "ICE",
  noise: "Noise",
  warm: "Warm-up",
  commit: "Switch",
  liveness: "Liveness",
};

/**
 * Which network the pair runs over. The host's end decides the route; this
 * device's candidate is often an mDNS name in browsers, so it only fills in
 * when the host's end is unknown too.
 */
export function routeScope(pair: RtcSelectedPair | undefined): RtcAddressScope | undefined {
  if (pair === undefined) return undefined;
  if (pair.remote.scope !== "unknown") return pair.remote.scope;
  if (pair.local.scope !== "unknown") return pair.local.scope;
  return undefined;
}

function routeLabel(pair: RtcSelectedPair | undefined): string | undefined {
  const scope = routeScope(pair);
  return scope === undefined ? undefined : SCOPE_LABEL[scope];
}

export function pathLabel(diagnostics: RtcDiagnostics): string {
  if (diagnostics.path !== "p2p") return PATH_LABEL[diagnostics.path];
  const route = routeLabel(diagnostics.selectedPair);
  return route === undefined ? "P2P" : `P2P · ${route}`;
}

/** Whole seconds below a minute, whole minutes below an hour, then hours. */
export function agoLabel(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function failureLabel(failure: P2PFailure): string {
  const stage = FAILURE_STAGE_LABEL[failure.stage];
  const reason = failure.reason === undefined ? stage : `${stage} — ${failure.reason}`;
  const route = routeLabel(failure.pair);
  return [reason, agoLabel(failure.agoMs), ...(route === undefined ? [] : [`on ${route}`])].join(" · ");
}

/** One candidate end, dropping the parts the platform did not report. */
export function candidateEndLabel(end: RtcCandidateEnd): string {
  const details = [end.type, end.address]
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join(" · ");
  return details === "" ? SCOPE_LABEL[end.scope] : `${details} (${SCOPE_LABEL[end.scope]})`;
}
