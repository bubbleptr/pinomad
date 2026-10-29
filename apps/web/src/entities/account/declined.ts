// Account hosts this device must not auto-register (ADR-0035 §5): the user
// forgot them, or the host refused the account vouching. Only an explicit
// "join" removes an identity. The set survives reloads.
import { normalizeServerOrigin, type AccountHostRef } from "@pinomad/client/account.ts";

export const DECLINED_KEY = "pinomad.declinedAccountHosts";

export interface DeclinedStore {
  list(): readonly AccountHostRef[];
  add(ref: AccountHostRef): void;
  remove(ref: AccountHostRef): void;
  /** Fired after add/remove, for models that cancel work tied to the entry. */
  subscribe(listener: () => void): () => void;
}

type DeclinedStorage = Pick<Storage, "getItem" | "setItem">;

const keyOf = (ref: AccountHostRef): string =>
  `${normalizeServerOrigin(ref.serverOrigin)}\u0000${ref.hostId}`;

const parse = (raw: string): AccountHostRef[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const refs: AccountHostRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as { serverOrigin?: unknown; hostId?: unknown };
    if (typeof value.serverOrigin !== "string" || typeof value.hostId !== "string") continue;
    const ref = { serverOrigin: normalizeServerOrigin(value.serverOrigin), hostId: value.hostId };
    const key = keyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
};

export function readDeclined(storage: DeclinedStorage): readonly AccountHostRef[] {
  const raw = storage.getItem(DECLINED_KEY);
  return raw === null ? [] : parse(raw);
}

export function createDeclinedStore(storage: DeclinedStorage = localStorage): DeclinedStore {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const write = (refs: readonly AccountHostRef[]): void => {
    storage.setItem(DECLINED_KEY, JSON.stringify(refs));
    notify();
  };
  return {
    list: () => readDeclined(storage),
    add: (ref) => {
      const normalized = { serverOrigin: normalizeServerOrigin(ref.serverOrigin), hostId: ref.hostId };
      const current = readDeclined(storage);
      const key = keyOf(normalized);
      if (current.some((entry) => keyOf(entry) === key)) return;
      write([...current, normalized]);
    },
    remove: (ref) => {
      const key = keyOf(ref);
      const current = readDeclined(storage);
      const next = current.filter((entry) => keyOf(entry) !== key);
      if (next.length !== current.length) write(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The renderer's persisted set — one per page, shared by the model and the UI. */
export const browserDeclined = createDeclinedStore();

/**
 * Cancel auto-registration for one account host (or all of them when the
 * account goes away). Pairing cannot be aborted mid-handshake, so the flight
 * checks this signal before it saves or announces anything.
 */
const cancelListeners = new Set<(hostId?: string) => void>();

export function cancelAccountRegistration(hostId?: string): void {
  for (const listener of cancelListeners) listener(hostId);
}

export function onAccountRegistrationCancel(listener: (hostId?: string) => void): () => void {
  cancelListeners.add(listener);
  return () => {
    cancelListeners.delete(listener);
  };
}
