// The `$` skill menu (issue #143), the composer's bound-skill draft and
// highlight (#308, ADR-0028), and the bubbles' mention marks. Astryx
// activates a trigger at a text node's start or after a literal
// space/newline. A pick inserts `$name ` as plain text, never a token, and
// binds that range (skill-bindings.ts); only bound names are sent as
// `skills` and painted. A hand-typed `$name` stays plain, unpainted text.
//
// One cache per host connection (`skillCacheFor`) keys listings by scope, so
// every composer in a scope shares a `listSkills` answer. A scope's listing
// is requested on mount/focus/`$` search and on reconnect; stale-but-known listings stay on screen while a
// refetch is in flight — the menu never flashes empty between answers.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import type { SkillScope } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { skillMentionRanges } from "@pinomad/client/skill-mentions.ts";
import { Sparkles } from "@/shared/ui/icons";
import type { ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { useCachedListing } from "@/shared/listing-cache";
import { applySkillHighlights } from "./skill-highlight.ts";
import { emptyDraft, followEdit, restoreDraft, type SkillDraft } from "./skill-bindings.ts";
import { SkillMentionCache, skillScopeKey, type ListedSkill } from "./skill-list.ts";

// The connection owns the cache: remote identity is the host, so the key's
// host half is implicit and a reconnect shares entries.
const caches = new WeakMap<RemoteDurable, SkillMentionCache>();

export function skillCacheFor(remote: RemoteDurable): SkillMentionCache {
  let cache = caches.get(remote);
  if (cache === undefined) {
    cache = new SkillMentionCache((scope) => remote.controller.listSkills(scope));
    caches.set(remote, cache);
  }
  return cache;
}

/**
 * The scope's listing out of the shared cache — subscribed so a landed answer
 * re-renders, and requested on mount, on a scope or `enabled` change (a
 * reconnect flips it and forces a fresh listing), whenever the entry is
 * missing or stale.
 */
export function useSkillList(
  remote: RemoteDurable,
  scope: SkillScope | undefined,
  enabled: boolean,
): { readonly skills: readonly ListedSkill[] | undefined; readonly request: () => void } {
  const { items, request } = useCachedListing(skillCacheFor(remote), scope, enabled);
  return { skills: items, request };
}

interface SkillAux {
  /** `auxiliaryData.group` — one headed section per entry source. */
  readonly group: "Project" | "User";
  readonly description?: string;
}

const skillItem = (skill: ListedSkill): ChatComposerTriggerItem => ({
  id: `skill:${skill.name}`,
  label: skill.name,
  auxiliaryData: { group: skill.source === "project" ? "Project" : "User", description: skill.description },
});

/**
 * Local ranking over the known list (issue #143): name prefix > name
 * substring > description substring, case-insensitive, listing order inside
 * a tier. Empty query lists everything in listing order.
 */
export function skillItems(skills: readonly ListedSkill[], query: string): ChatComposerTriggerItem[] {
  const needle = query.toLowerCase();
  return skills
    .flatMap((skill, index) => {
      const name = skill.name.toLowerCase();
      const tier = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : skill.description.toLowerCase().includes(needle) ? 2 : -1;
      return tier < 0 ? [] : [{ skill, index, tier }];
    })
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ skill }) => skillItem(skill));
}

/**
 * The composer's `$` trigger and `request` for a focus refresh. A pick
 * inserts `$name ` and reports the name to `onPick` (`SkillDraftState.pick`)
 * so the draft binds it. Undefined trigger = no menu (a disconnected or
 * pre-5.13 host).
 */
export function useSkillMentions(
  remote: RemoteDurable,
  scope: SkillScope | undefined,
  inputRef: RefObject<ChatPromptInputHandle | null>,
  enabled: boolean,
  onPick: (name: string) => void,
): {
  readonly trigger: ChatComposerTrigger | undefined;
  readonly request: () => void;
} {
  const cache = skillCacheFor(remote);
  const key = scope === undefined ? undefined : skillScopeKey(scope);
  const { skills, request } = useSkillList(remote, scope, enabled);
  // A landed listing reaches an open menu through a synthetic input event,
  // same as the `@` fetcher — the state update alone doesn't re-run the search.
  useEffect(() => {
    if (skills !== undefined) inputRef.current?.emitInput();
  }, [skills, inputRef]);
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const trigger = useMemo<ChatComposerTrigger | undefined>(() => {
    if (!enabled || scope === undefined) return undefined;
    const searchSource: SearchSource = {
      bootstrap: () => [],
      // Sync array like the `@` source — a stale listing refetches while its
      // answer keeps showing (issue #143 §web), never a promise.
      search: (query) => {
        const current = scopeRef.current;
        if (current !== undefined) cache.request(current);
        return skillItems(skillsRef.current ?? [], query);
      },
      cancel: () => {},
    };
    return {
      character: "$",
      searchSource,
      menuLabel: "Skills",
      emptySearchResultsText: "No matching skills",
      renderItem: (item) => {
        const aux = item.auxiliaryData as SkillAux | undefined;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block truncate">{item.label}</span>
              {aux?.description === undefined ? null : (
                <span className="block truncate text-xs text-muted">{aux.description}</span>
              )}
            </span>
          </span>
        );
      },
      // Plain text, not a token (#143): the message must survive being copied
      // into an ordinary prompt. The pick binds it (ADR-0028).
      onSelect: (item) => {
        onPickRef.current(item.label);
        return `$${item.label} `;
      },
    };
    // A new scope or a landed listing rebuilds the trigger so Astryx's next
    // search reads the fresh list.
  }, [enabled, cache, key, skills]);
  return { trigger, request };
}

export interface SkillDraftState {
  /** The composer value — a plain string. */
  readonly value: string;
  /** The value with its bound `$name` ranges. */
  readonly draft: SkillDraft;
  /** Every value change, typed or programmatic: the bindings follow it. */
  readonly setValue: (next: string) => void;
  /** A `$` menu pick: the value change it causes binds `$name`. */
  readonly pick: (name: string) => void;
  /** Refill the composer: `text`, with its mentions of `skills` bound. */
  readonly restore: (text: string, skills: readonly string[]) => void;
}

/** The composer's draft: a plain string plus the skills picked into it. */
export function useSkillDraft(): SkillDraftState {
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft);
  // Astryx calls onSelect, then emits the value with the inserted text.
  const picked = useRef<string | undefined>(undefined);
  const setValue = useCallback((next: string) => {
    const name = picked.current;
    picked.current = undefined;
    setDraft((current) => followEdit(current, next, name));
  }, []);
  const pick = useCallback((name: string) => {
    picked.current = name;
  }, []);
  const restore = useCallback((text: string, skills: readonly string[]) => {
    picked.current = undefined;
    setDraft(restoreDraft(text, skills));
  }, []);
  return { value: draft.text, draft, setValue, pick, restore };
}

/**
 * Paint the draft's bound `$name` ranges inside the composer's editable via
 * the CSS Custom Highlight API — ranges over the contentEditable's own text
 * nodes, the DOM never touched.
 */
export function useSkillHighlight(inputRef: RefObject<ChatPromptInputHandle | null>, draft: SkillDraft): void {
  useEffect(() => {
    const editable = inputRef.current?.editable();
    if (editable === undefined || editable === null || draft.bindings.length === 0) return;
    return applySkillHighlights(editable, draft.bindings);
  }, [inputRef, draft]);
}

/**
 * A sent message's text with the `$name` mentions of the skills the host
 * expanded into it (the chat item's `skills`) wrapped in highlight marks.
 */
export function SkillMentionText({ text, names }: { text: string; names: readonly string[] }): ReactNode {
  const ranges = useMemo(
    () => (names.length === 0 ? [] : skillMentionRanges(text, names)),
    [text, names],
  );
  if (ranges.length === 0) return <>{text}</>;
  const pieces: ReactNode[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    if (range.start > at) pieces.push(text.slice(at, range.start));
    pieces.push(
      <mark key={index} className="chat-skill-mention">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  });
  if (at < text.length) pieces.push(text.slice(at));
  return <>{pieces}</>;
}
