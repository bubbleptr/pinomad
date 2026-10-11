// The one connected RemoteDurable, published app-wide: sibling Stack routes
// (conversation/[id], new) can't see the index screen's state, so the
// host connection registers its remote and reconnect here.
import { useSyncExternalStore } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";

export type ActiveRemote = {
  readonly remote: RemoteDurable;
  /** Reconnect the transport (the connected view's retry). */
  readonly reconnect: () => void;
};

let active: ActiveRemote | undefined;
const listeners = new Set<() => void>();

export function setActiveRemote(next: ActiveRemote | undefined): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useActiveRemote(): RemoteDurable | undefined {
  return useSyncExternalStore(subscribe, () => active?.remote);
}

export function useActiveReconnect(): (() => void) | undefined {
  return useSyncExternalStore(subscribe, () => active?.reconnect);
}
