// One focused host/conversation for the whole app (ADR-0035 §1). The stored
// value is only a load-time hint: the live focus lives in React state.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { StoredHost } from "@pinomad/client/stored-host.ts";

/** localStorage key holding the last focused host and conversation. */
export const FOCUS_KEY = "pinomad.focus";

/** The pre-multi-host key: a bare hostKey, migrated once on read. */
export const LEGACY_ACTIVE_HOST_KEY = "pinomad.activeHost";

export interface ConversationRef {
  readonly hostKey: string;
  readonly conversationId: ConversationId;
}

/** The screen's focus: a conversation, or a host showing its draft. */
export interface HostFocus {
  readonly hostKey: string;
  readonly conversationId?: ConversationId;
}

type FocusStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isConversationId = (value: unknown): value is ConversationId =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseFocus = (raw: string): HostFocus | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = parsed as { hostKey?: unknown; conversationId?: unknown };
  if (typeof value.hostKey !== "string" || value.hostKey === "") return undefined;
  if (value.conversationId === undefined) return { hostKey: value.hostKey };
  return isConversationId(value.conversationId)
    ? { hostKey: value.hostKey, conversationId: value.conversationId }
    : undefined;
};

/**
 * Read the remembered focus, folding in the legacy activeHost key. A host that
 * is no longer paired falls back to the first one; no hosts means no focus.
 */
export function readFocus(storage: FocusStorage, hosts: readonly StoredHost[]): HostFocus | undefined {
  if (hosts.length === 0) return undefined;
  const known = new Set(hosts.map((host) => host.hostKey));
  const stored = storage.getItem(FOCUS_KEY);
  if (stored !== null) {
    const focus = parseFocus(stored);
    if (focus !== undefined && known.has(focus.hostKey)) return focus;
  }
  const legacy = storage.getItem(LEGACY_ACTIVE_HOST_KEY);
  if (legacy !== null && known.has(legacy)) {
    // Migrate once; a later read uses the new shape.
    storage.setItem(FOCUS_KEY, JSON.stringify({ hostKey: legacy }));
    storage.removeItem(LEGACY_ACTIVE_HOST_KEY);
    return { hostKey: legacy };
  }
  return { hostKey: hosts[0]!.hostKey };
}

/** Seed the per-host memory from the focus restored after a reload. */
export function seedRememberedFocus(
  lastByHost: Map<string, ConversationId>,
  focus: HostFocus | null | undefined,
): void {
  if (focus?.conversationId !== undefined) lastByHost.set(focus.hostKey, focus.conversationId);
}

/** The ref focusHost restores for a menu pick. */
export function rememberedHostFocus(
  lastByHost: Map<string, ConversationId>,
  hostKey: string,
): HostFocus {
  const conversationId = lastByHost.get(hostKey);
  return conversationId === undefined ? { hostKey } : { hostKey, conversationId };
}

/**
 * Finish a manual pairing by focusing the new host. Snapshot the outgoing
 * host's live conversation first so switching back restores it. Re-pairing
 * the same host keeps its conversation instead of dropping to the draft.
 */
export function focusPairedHost(
  lastByHost: Map<string, ConversationId>,
  current: HostFocus | null | undefined,
  nextHostKey: string,
): HostFocus {
  if (current?.conversationId !== undefined) lastByHost.set(current.hostKey, current.conversationId);
  if (current?.hostKey === nextHostKey) {
    const conversationId = current.conversationId ?? lastByHost.get(nextHostKey);
    return conversationId === undefined ? { hostKey: nextHostKey } : { hostKey: nextHostKey, conversationId };
  }
  // A different host starts on its draft even if an old entry survived.
  lastByHost.delete(nextHostKey);
  return { hostKey: nextHostKey };
}

export function writeFocus(storage: FocusStorage, focus: HostFocus | undefined): void {
  if (focus === undefined) {
    storage.removeItem(FOCUS_KEY);
    return;
  }
  storage.setItem(
    FOCUS_KEY,
    JSON.stringify(
      focus.conversationId === undefined
        ? { hostKey: focus.hostKey }
        : { hostKey: focus.hostKey, conversationId: focus.conversationId },
    ),
  );
}
