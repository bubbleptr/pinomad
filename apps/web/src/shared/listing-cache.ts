// A host listing cache shared by the composer's trigger menus — `$` skills
// (issue #143) and `/` commands (issue #254): one cache per host connection,
// keyed by scope. Concurrent callers ride one call, the answer is reused for
// a few seconds, and a failed call is never cached — the next request
// retries. Plain state, no React: `useCachedListing` wires `subscribe` into
// `useSyncExternalStore`.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/** How long a scope's listing is trusted before the next request refetches it — seconds, so a new entry appears on the next focus. */
export const LISTING_TTL_MS = 5_000;

// Eviction bound — a long session can collect one entry per opened scope.
const MAX_ENTRIES = 64;

interface Entry<Item> {
  /** The last good answer — kept past its TTL so a slow refetch never blanks the menu. */
  items?: readonly Item[];
  at: number;
  /** The request currently resolving for this scope. */
  inflight?: Promise<unknown>;
  readonly listeners: Set<() => void>;
}

export class ListingCache<Scope, Listing, Item> {
  readonly #list: (scope: Scope) => Promise<Listing>;
  readonly #keyOf: (scope: Scope) => string;
  readonly #itemsOf: (listing: Listing) => readonly Item[];
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, Entry<Item>>();

  constructor(
    list: (scope: Scope) => Promise<Listing>,
    keyOf: (scope: Scope) => string,
    itemsOf: (listing: Listing) => readonly Item[],
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.#list = list;
    this.#keyOf = keyOf;
    this.#itemsOf = itemsOf;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? LISTING_TTL_MS;
  }

  /** The stable partition a scope maps to — a scope change never serves another scope's list. */
  keyOf(scope: Scope): string {
    return this.#keyOf(scope);
  }

  #entry(key: string): Entry<Item> {
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { at: 0, listeners: new Set() };
      this.#entries.set(key, entry);
      if (this.#entries.size > MAX_ENTRIES) {
        // Drop the oldest entry nobody is listening to or waiting on.
        for (const [cached, other] of this.#entries) {
          if (cached !== key && other.inflight === undefined && other.listeners.size === 0) {
            this.#entries.delete(cached);
            break;
          }
        }
      }
    }
    return entry;
  }

  /** The scope's last good listing, or undefined until the first answer lands. */
  snapshot(scope: Scope): readonly Item[] | undefined {
    return this.#entries.get(this.#keyOf(scope))?.items;
  }

  /**
   * Ask for the scope's listing. Fresh answers and in-flight calls are a
   * no-op; a stale answer stays visible while the refetch runs. Failures
   * leave the entry untouched — the next request retries. `force` bypasses
   * the TTL — the refresh a reconnect performs.
   */
  request(scope: Scope, force = false): void {
    const entry = this.#entry(this.#keyOf(scope));
    if (entry.inflight !== undefined) return;
    if (!force && entry.items !== undefined && this.#now() - entry.at < this.#ttlMs) return;
    const inflight = this.#list(scope);
    entry.inflight = inflight;
    inflight.then(
      (listing) => {
        if (entry.inflight === inflight) {
          entry.items = this.#itemsOf(listing);
          entry.at = this.#now();
          for (const listener of entry.listeners) listener();
        }
      },
      () => {},
    ).finally(() => {
      if (entry.inflight === inflight) entry.inflight = undefined;
    });
  }

  /** Re-run `listener` when the scope's listing lands. */
  subscribe(scope: Scope, listener: () => void): () => void {
    const listeners = this.#entry(this.#keyOf(scope)).listeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}

const NO_LISTEN = () => () => {};

/**
 * The scope's listing out of `cache` — subscribed so a landed answer
 * re-renders, and requested on mount, on a scope or `enabled` change (a
 * reconnect flips it), whenever the entry is missing or stale. `request` is
 * the focus refresh.
 */
export function useCachedListing<Scope, Listing, Item>(
  cache: ListingCache<Scope, Listing, Item>,
  scope: Scope | undefined,
  enabled: boolean,
): { readonly items: readonly Item[] | undefined; readonly request: () => void } {
  const key = scope === undefined ? undefined : cache.keyOf(scope);
  const items = useSyncExternalStore(
    useCallback((notify) => (key === undefined ? NO_LISTEN : cache.subscribe(scope!, notify)), [cache, key]),
    useCallback(() => (key === undefined ? undefined : cache.snapshot(scope!)), [cache, key]),
  );
  // The latest scope/enabled through refs: `request` must not churn identity
  // when a caller rebuilds the scope object each render.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const request = useCallback(() => {
    const scope = scopeRef.current;
    if (enabledRef.current && scope !== undefined) cache.request(scope);
  }, [cache]);
  // Mount and scope changes refresh only when stale; a reconnect (enabled
  // flipping back on) forces a fresh listing — the host may have changed
  // while the client was away.
  const wasDown = useRef(false);
  useEffect(() => {
    if (!enabled) {
      wasDown.current = true;
      return;
    }
    const scope = scopeRef.current;
    if (scope !== undefined) cache.request(scope, wasDown.current);
    wasDown.current = false;
  }, [cache, enabled, key]);
  return { items: enabled ? items : undefined, request };
}
