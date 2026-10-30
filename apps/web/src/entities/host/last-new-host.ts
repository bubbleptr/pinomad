// Which host the frame's global "New chat" opens. Only the last successful
// draft create chooses a host; a fresh install has no preference yet.
import type { StoredHost } from "@pinomad/client/stored-host.ts";

/** localStorage key holding the host of the last conversation created from a draft. */
export const LAST_NEW_HOST_KEY = "pinomad.lastNewHost";

export type LastNewHostStorage = Pick<Storage, "getItem" | "setItem">;

export function readLastNewHost(storage: LastNewHostStorage): string | undefined {
  const value = storage.getItem(LAST_NEW_HOST_KEY);
  return value === null || value === "" ? undefined : value;
}

export function writeLastNewHost(storage: LastNewHostStorage, hostKey: string): void {
  storage.setItem(LAST_NEW_HOST_KEY, hostKey);
}

/**
 * Pick the host of a newly opened draft (ADR-0035 §7). Prefer the host that
 * last created a conversation, then the first connected host in paired order;
 * with no live host, keep the remembered one when it is still paired, else the
 * first pair. A forgotten host is never picked, even if its old runtime still
 * reports a connection.
 */
export function selectNewChatHost({
  hosts,
  lastNewHost,
  connected,
}: {
  readonly hosts: readonly Pick<StoredHost, "hostKey">[];
  readonly lastNewHost: string | undefined;
  readonly connected: (hostKey: string) => boolean;
}): string | undefined {
  if (hosts.length === 0) return undefined;
  const paired = new Set(hosts.map((host) => host.hostKey));
  const remembered = lastNewHost !== undefined && paired.has(lastNewHost) ? lastNewHost : undefined;
  if (remembered !== undefined && connected(remembered)) return remembered;
  const firstConnected = hosts.find((host) => connected(host.hostKey));
  if (firstConnected !== undefined) return firstConnected.hostKey;
  return remembered ?? hosts[0]!.hostKey;
}
