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

/** A private slot for hooks used outside a host runtime (side panel, stories, tests). */
export function useLocalComposerSlot(): ComposerSlot {
  const store = useRef<HostComposerStore | undefined>(undefined);
  store.current ??= new HostComposerStore();
  return useMemo(() => store.current!.slot("local"), []);
}
