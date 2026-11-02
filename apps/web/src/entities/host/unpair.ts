import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";

/**
 * Unpair this device from `host`. A pairing lives at both ends, so while the
 * host is reachable (`remote`) ask it to drop this device's key first — a
 * refusal arrives as the host's notice — then forget the host here either
 * way. Without `remote` only this end goes, and the host keeps listing the
 * device until it is unpaired there.
 */
export async function unpairHost({
  host,
  remote,
  forget,
}: {
  host: StoredHost;
  remote: RemoteDurable | undefined;
  forget: (hostKey: string) => Promise<void>;
}): Promise<void> {
  if (remote !== undefined) {
    await remote.controller.revokeDevice(toBase64Url(keyPairFromPrivate(fromBase64Url(host.privateKey)).publicKey));
  }
  await forget(host.hostKey);
}
