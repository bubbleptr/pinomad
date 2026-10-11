// The one connected RemoteDurable, published app-wide: sibling Stack routes
// (conversation/[id], new) can't see the index screen's state, so the
// connected view registers its remote here and clears it on unmount.
import { useSyncExternalStore } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";

let remote: RemoteDurable | undefined;
const listeners = new Set<() => void>();

export function setActiveRemote(next: RemoteDurable | undefined): void {
  if (remote === next) return;
  remote = next;
  for (const listener of listeners) listener();
}

/** Unmount cleanup: clears only if `expected` is still the published remote. */
export function clearActiveRemote(expected: RemoteDurable): void {
  if (remote === expected) setActiveRemote(undefined);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useActiveRemote(): RemoteDurable | undefined {
  return useSyncExternalStore(subscribe, () => remote);
}
