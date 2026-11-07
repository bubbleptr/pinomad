// The ways this device can reach one paired machine (#502): the same ordered
// candidates a connection round dials (ADR-0032), described for Settings →
// Hosts.
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import {
  candidatePlan,
  filterCandidatesForMode,
  type RemoteCandidate,
} from "@pinomad/protocol/remote-candidates.ts";
import { rtcAddressScope, type RtcAddressScope } from "@pinomad/protocol/rtc.ts";
import { SCOPE_LABEL } from "./hosts-diagnostics.ts";

export interface HostRoute {
  readonly url: string;
  /** Which network or server carries it: "Account relay", "Tailnet", "LAN"… */
  readonly label: string;
  /** host[:port], without the scheme or path. */
  readonly address: string;
  /**
   * `off`: the host's connection mode leaves it out. `blocked`: this page
   * cannot open it (an insecure remote socket from an HTTPS page).
   */
  readonly state: "available" | "off" | "blocked";
}

export interface HostRoutesOptions {
  /** The page's protocol, for example `window.location.protocol`. */
  readonly pageProtocol?: string;
}

const hostnameOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const addressOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * An endpoint the host published is named by the host's own config, so a
 * MagicDNS or mDNS name is trusted here (RTC candidates are not, see rtc.ts).
 */
function scopeOf(url: string): RtcAddressScope {
  const scope = rtcAddressScope(addressOf(url));
  if (scope !== "unknown") return scope;
  const hostname = hostnameOf(url) ?? "";
  if (hostname.endsWith(".ts.net")) return "tailnet";
  if (hostname.endsWith(".local")) return "lan";
  return "unknown";
}

function labelOf(candidate: RemoteCandidate, accountHostname: string | undefined): string {
  const isAccountServer = accountHostname !== undefined && hostnameOf(candidate.url) === accountHostname;
  if (candidate.role === "relay") return isAccountServer ? "Account relay" : "Relay";
  if (candidate.role === "loopback") return SCOPE_LABEL.loopback;
  // A legacy url carries no role: the account's server is still its relay.
  if (candidate.role === "legacy" && isAccountServer) return "Account relay";
  const scope = scopeOf(candidate.url);
  return scope === "unknown" ? "Direct" : SCOPE_LABEL[scope];
}

export function hostRoutes(host: StoredHost, options: HostRoutesOptions = {}): HostRoute[] {
  const candidates = candidatePlan(
    host.url,
    host.endpointSet,
    options.pageProtocol === undefined ? {} : { pageProtocol: options.pageProtocol },
  );
  const allowed = new Set(filterCandidatesForMode(candidates, host.connectionMode ?? "auto").map((c) => c.url));
  const accountHostname = host.account === undefined ? undefined : hostnameOf(host.account.serverOrigin);
  const state = (candidate: RemoteCandidate): HostRoute["state"] =>
    candidate.unsupported !== undefined ? "blocked" : allowed.has(candidate.url) ? "available" : "off";

  return candidates.map((candidate) => ({
    url: candidate.url,
    label: labelOf(candidate, accountHostname),
    address: addressOf(candidate.url),
    state: state(candidate),
  }));
}
