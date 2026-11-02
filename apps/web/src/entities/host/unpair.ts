import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";

/** How long the host gets to drop this device before it is forgotten here anyway (iOS waits as long). */
const REVOKE_WAIT_MS = 5_000;

/**
 * Unpair this device from `host`. A pairing lives at both ends, so while the
 * host is reachable (`remote`) ask it to drop this device's key first — a
 * refusal arrives as the host's notice — then forget the host here either
 * way. Without `remote`, or when the host doesn't answer in time (a hung
 * process behind an open socket never does), only this end goes and the
 * host keeps listing the device until it is unpaired there.
 */
export async function unpairHost({
  host,
  remote,
  forget,
}: {
  host: StoredHost;
  remote: RemoteDurable | undefined;
  forget: (hostKey: string) => Promise<void>;
}): Promise<{ hostAnswered: boolean }> {
  let hostAnswered = false;
  if (remote !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    hostAnswered = await Promise.race([
      remote.controller
        .revokeDevice(toBase64Url(keyPairFromPrivate(fromBase64Url(host.privateKey)).publicKey))
        .then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), REVOKE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  await forget(host.hostKey);
  return { hostAnswered };
}

/** The toast for a connected host that didn't answer the unpair in time: only this end went. */
export function unansweredUnpair(label: string): { body: string; type: "info" } {
  return {
    body: `${label} didn't answer, so only this device forgot it. Unpair this device under Settings → Devices on ${label}.`,
    type: "info",
  };
}
