// The file half of the `@` mention menu (#138): a debounced, deduplicated
// fetcher that is the only place owning request generations. Results land in
// `onItems` keyed by `scopeKey + query`, so a late answer can only touch its
// own slot — never the list the menu currently shows. Plain state, no React:
// the hook wires `onItems` into a state update.
import type { FileListing } from "@pinomad/protocol/organization.ts";

export const MENTION_FETCH_DEBOUNCE_MS = 150;

/** The cache slot one query fills — scope key included so a scope change never serves stale paths. */
export const mentionCacheKey = (scopeKey: string, query: string): string => `${scopeKey}${query}`;

export interface MentionFetcher {
  /**
   * Ask for the listing behind `cacheKey`; debounced and deduplicated — a key
   * already scheduled or in flight is a no-op.
   */
  request(cacheKey: string, list: () => Promise<FileListing>): void;
  /**
   * Invalidate pending and in-flight work: the pending timer is cleared and
   * in-flight answers are dropped when they resolve (menu close, a new query,
   * unmount). Answered cache entries are unaffected — they belong to the hook.
   */
  cancel(): void;
}

/**
 * One fetcher per composer mount. Every cancel bumps the generation the
 * scheduled fetches captured — anything resolving under an old generation is
 * dropped, and because answers are keyed by scope+query a slow listing can
 * never overwrite the items a faster one already delivered.
 */
export function createMentionFetcher(onItems: (cacheKey: string, files: readonly string[]) => void): MentionFetcher {
  let generation = 0;
  let pending: { readonly cacheKey: string; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  const inFlight = new Set<string>();

  return {
    request(cacheKey, list) {
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending = undefined;
      }
      if (inFlight.has(cacheKey)) return;
      const captured = generation;
      pending = {
        cacheKey,
        timer: setTimeout(() => {
          pending = undefined;
          if (captured !== generation || inFlight.has(cacheKey)) return;
          inFlight.add(cacheKey);
          list().then(
            (listing) => {
              inFlight.delete(cacheKey);
              if (captured === generation) onItems(cacheKey, listing.files);
            },
            () => {
              // A failed request leaves the slot unanswered: the next search
              // for it retries, and the agent candidates stay as they were.
              inFlight.delete(cacheKey);
            },
          );
        }, MENTION_FETCH_DEBOUNCE_MS),
      };
    },
    cancel() {
      generation += 1;
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending = undefined;
      }
    },
  };
}
