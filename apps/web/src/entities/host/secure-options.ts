// The candidate-mode options every secure client builds: a stored host's RTC
// coordinator and transport, plus the optional one-time pairing context.
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import type { PairingContext, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import type { RemoteCandidate } from "@pinomad/protocol/remote-candidates.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { createBrowserRtcPlatform } from "./browser-rtc.ts";
import {
  fromBase64Url,
  secureWebSocketTransport,
  SIGNAL_PROLOGUE,
} from "@pinomad/protocol/secure-channel.ts";

export type RtcPlatform = ReturnType<typeof createBrowserRtcPlatform>;

export function secureOptions({
  hostKey,
  device,
  target,
  candidates,
  stored,
  pairing,
  rtcPlatform,
  onPaired,
  onEndpointSet,
  setConnection,
}: {
  hostKey: string;
  device: KeyPair;
  target: { readonly url: string; readonly endpointSet?: EndpointSet };
  candidates: readonly RemoteCandidate[];
  stored?: StoredHost;
  pairing?: PairingContext;
  rtcPlatform: RtcPlatform;
  onPaired?: () => void;
  onEndpointSet: (endpointSet: EndpointSet) => void;
  setConnection: (hostKey: string, change: { rtcSignalOnly: boolean }) => Promise<void>;
}): RemoteDurableOptions {
  const hostKeyBytes = fromBase64Url(hostKey);
  const rtc =
    rtcPlatform === undefined
      ? undefined
      : {
          platform: rtcPlatform,
          hostKey: hostKeyBytes,
          device,
          signalOnlyHint: stored?.rtcSignalOnly === true,
          openSignalTransport: (candidate: RemoteCandidate) =>
            secureWebSocketTransport({
              url: candidate.url,
              hostKey: hostKeyBytes,
              device,
              prologue: SIGNAL_PROLOGUE,
            }),
          onSignalOnly: (signalOnly: boolean) => {
            void setConnection(hostKey, { rtcSignalOnly: signalOnly }).catch((error: unknown) =>
              console.error("Could not store the host's RTC hint", error),
            );
          },
          onSignalOnlyError: (error: Error) => console.error("Could not store the host's RTC hint", error),
        };
  return {
    candidates,
    legacyUrl: target.url,
    pageProtocol: window.location.protocol,
    ...(stored?.connectionMode === undefined ? {} : { connectionMode: stored.connectionMode }),
    ...(pairing === undefined ? {} : { pairing }),
    ...(rtc === undefined ? {} : { rtc }),
    ...(onPaired === undefined ? {} : { onPaired }),
    openTransport: (candidate: RemoteCandidate, currentPairing: PairingContext | undefined) =>
      secureWebSocketTransport({
        url: candidate.url,
        hostKey: hostKeyBytes,
        device,
        ...(currentPairing === undefined ? {} : { pairing: currentPairing }),
      }),
    onEndpointSet,
  };
}
