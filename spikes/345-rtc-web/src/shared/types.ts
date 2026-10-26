export type Mode = "connect" | "noise" | "maxmsg";
export type SdpMaxMessageSize = "default" | "missing" | "0" | "65536";

export type PeerConfig = {
  role: "host";
  wsUrl: string;
  mode: Mode;
  stun: string[];
  hostPrivateKey: string;
  bindAddress?: string;
  sdpMaxMessageSize?: SdpMaxMessageSize;
  sizes?: number[];
  frameSeed?: number;
  frameBytes?: number;
  testId: string;
};

export type BrowserConfig = {
  wsUrl: string;
  mode: Mode;
  stun: string[];
  hostPublicKey: string;
  frameSeed?: number;
  frameBytes?: number;
  sizes?: number[];
  testId: string;
};

export type CandidateInfo = {
  raw: string;
  foundation?: string;
  component?: string;
  transport?: string;
  priority?: string;
  address?: string;
  port?: string;
  type?: string;
  isMdns: boolean;
};

/** Parse the SDP candidate line shape used by both libdatachannel and Chromium. */
export function parseCandidate(raw: string): CandidateInfo {
  const parts = raw.trim().split(/\s+/);
  const address = parts[4];
  return {
    raw,
    foundation: parts[0]?.replace(/^candidate:/, ""),
    component: parts[1],
    transport: parts[2],
    priority: parts[3],
    address,
    port: parts[5],
    type: parts[7],
    isMdns: address?.endsWith(".local") === true,
  };
}
