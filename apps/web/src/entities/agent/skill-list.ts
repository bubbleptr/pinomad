// The skill listing behind the `$` menu and the bubble/composer highlights
// (issue #143): one cache per host connection, keyed by scope. Concurrent
// callers ride one `listSkills` call, the answer is reused for a few seconds,
// and a failed call is never cached — the next request retries. Plain state,
// no React: the hooks wire `subscribe` into `useSyncExternalStore`.
import type { SkillListing, SkillScope } from "@pinomad/protocol/organization.ts";

/** One listed skill — the name a `$` mention types, the one-line description the menu shows, and which entry supplied it. */
export type ListedSkill = SkillListing["skills"][number];

/** How long a scope's listing is trusted before the next request refetches it — seconds, so a newly added skill appears on the next focus. */
export const SKILL_LIST_TTL_MS = 5_000;

// Eviction bound — a long session can collect one entry per opened scope.
const MAX_ENTRIES = 64;

/** The stable cache partition a scope maps to — a scope change never serves another scope's list. */
export const skillScopeKey = (scope: SkillScope): string =>
  scope.kind === "conversation"
    ? `conversation:${scope.conversationId}`
    : scope.kind === "project"
      ? `project:${scope.path}:${scope.checkout}`
      : "chat";

interface Entry {
  /** The last good answer — kept past its TTL so a slow refetch never blanks the menu. */
  skills?: readonly ListedSkill[];
  at: number;
  /** The request currently resolving for this scope. */
  inflight?: Promise<SkillListing>;
  readonly listeners: Set<() => void>;
}

export class SkillMentionCache {
  readonly #list: (scope: SkillScope) => Promise<SkillListing>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, Entry>();

  constructor(list: (scope: SkillScope) => Promise<SkillListing>, options: { now?: () => number; ttlMs?: number } = {}) {
    this.#list = list;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? SKILL_LIST_TTL_MS;
  }

  #entry(key: string): Entry {
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
  snapshot(scope: SkillScope): readonly ListedSkill[] | undefined {
    return this.#entries.get(skillScopeKey(scope))?.skills;
  }

  /**
   * Ask for the scope's listing. Fresh answers and in-flight calls are a
   * no-op; a stale answer stays visible while the refetch runs. Failures
   * leave the entry untouched — the next request retries. `force` bypasses
   * the TTL — the refresh a reconnect performs (issue #143).
   */
  request(scope: SkillScope, force = false): void {
    const key = skillScopeKey(scope);
    const entry = this.#entry(key);
    if (entry.inflight !== undefined) return;
    if (!force && entry.skills !== undefined && this.#now() - entry.at < this.#ttlMs) return;
    const inflight = this.#list(scope);
    entry.inflight = inflight;
    inflight.then(
      (listing) => {
        if (entry.inflight === inflight) {
          entry.skills = listing.skills;
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
  subscribe(scope: SkillScope, listener: () => void): () => void {
    const key = skillScopeKey(scope);
    const listeners = this.#entry(key).listeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}
