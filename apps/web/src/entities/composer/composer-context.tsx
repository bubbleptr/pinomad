import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import {
  HostComposerStore,
  type ComposerSlot,
  type ComposerSlotState,
  newDraftKey,
} from "./composer-store.ts";

export const HostComposerContext = createContext<HostComposerStore | undefined>(undefined);

/**
 * A slot for one host's draft target: `new` for the draft screen,
 * `conversation:<id>` for a live composer. Outside a host runtime (token
 * clients, isolated stories) a stable per-hook store keeps the old local
 * behavior without leaking between components.
 */
export function useComposerSlot(key: string = newDraftKey): ComposerSlot {
  const store = useContext(HostComposerContext);
  const local = useRef<HostComposerStore | undefined>(undefined);
  local.current ??= new HostComposerStore();
  const target = store ?? local.current;
  return useMemo(() => target.slot(key), [key, target]);
}

export function useComposerSlotState(slot: ComposerSlot): ComposerSlotState {
  return useSyncExternalStore(slot.subscribe, slot.snapshot);
}

// Stable no-ops let a caller subscribe to a slot that does not exist yet (a
// host still connecting) without breaking the hook order.
const noSubscribe = (): (() => void) => () => {};
const noSnapshot = (): undefined => undefined;

export function useOptionalComposerSlotState(
  slot: ComposerSlot | undefined,
): ComposerSlotState | undefined {
  return useSyncExternalStore(slot?.subscribe ?? noSubscribe, slot?.snapshot ?? noSnapshot);
}

/** A private slot for hooks used outside a host runtime (side panel, stories, tests). */
export function useLocalComposerSlot(): ComposerSlot {
  const store = useRef<HostComposerStore | undefined>(undefined);
  store.current ??= new HostComposerStore();
  return useMemo(() => store.current!.slot("local"), []);
}
