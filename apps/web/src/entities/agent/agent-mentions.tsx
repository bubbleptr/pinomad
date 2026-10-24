// The `@` mention menu (ADR-0023 §4 + #138's file completion): one trigger
// per composer. Named agents filter locally and show instantly; file
// candidates come from `listFiles` and append asynchronously — the search
// stays synchronous so the menu never debounces, and each answered listing
// lands in state, recreates the trigger, and makes Astryx re-run the search
// with the merged list.
//
// Two Astryx 0.3.0 quirks this is built around: `useTriggerMenu` calls
// `search('')` before every real search to detect async sources (the result
// is discarded — a promise from it would be an unhandled rejection, so
// `search` always returns an array), and it never checks generations, so a
// late answer must not be able to overwrite a newer one — the fetcher keys
// results by scope+query and drops whatever resolves after a cancel.
//
// Answered listings live only for MENTION_LISTING_TTL_MS: the main composer
// is mounted for the whole session, so without expiry a file created after
// the first `@foo` would never appear, and every typed query would grow the
// cache. While a new query is in flight the menu keeps showing the previous
// answer from the SAME scope (iOS's MentionMenu does the same) — a scope
// change hides the old root's paths immediately.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { FileListing } from "@pinomad/protocol/organization.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Bot, FileIcon } from "@/shared/ui/icons";
import type { ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { createMentionFetcher, mentionCacheKey } from "./mention-fetcher.ts";

/** How long an answered listing is reused before the next search refetches it. */
export const MENTION_LISTING_TTL_MS = 5_000;

/** The listing source a composer offers, or none (Chat drafts, pre-5.10 hosts). */
export interface MentionFiles {
  /** Cache partition — the root's identity (scope kind + id), so a scope change never serves stale paths. */
  readonly key: string;
  readonly list: (query: string) => Promise<FileListing>;
}

interface MentionAux {
  readonly kind: "agent" | "file";
  /** `auxiliaryData.group` — Astryx's `groupItems` renders one headed section per value. */
  readonly group: "Agents" | "Files";
  readonly description?: string;
  /** What `onSelect` inserts into the editable. */
  readonly insert: string;
}

interface AnsweredListing {
  readonly files: readonly string[];
  /** `Date.now()` of the answer, for TTL. */
  readonly at: number;
}

/** Every answered query so far plus the newest answer for the keep-showing fallback. */
interface Listings {
  readonly byKey: Readonly<Record<string, AnsweredListing>>;
  readonly latest?: { readonly scope: string; readonly files: readonly string[] };
}

const agentItem = (role: AgentRole): ChatComposerTriggerItem => ({
  id: `agent:${role.name}`,
  label: role.name,
  auxiliaryData: { kind: "agent", group: "Agents", description: role.description, insert: `@${role.name} ` },
});

const fileItem = (path: string): ChatComposerTriggerItem => ({
  id: `file:${path}`,
  label: path,
  auxiliaryData: { kind: "file", group: "Files", insert: `@./${path} ` },
});

const auxOf = (item: ChatComposerTriggerItem): MentionAux | undefined =>
  item.auxiliaryData as MentionAux | undefined;

/**
 * The trigger list for `ChatPromptInput`'s `triggers` prop, or undefined.
 * Undefined matters: with triggers configured Astryx turns the editable into
 * role="combobox", and an empty source would surface a "No results" popup on
 * every stray `@`. `view.agents === null` means the host predates 5.6; a
 * missing `files` means the scope has no listing (Chat, or a pre-5.10 host).
 *
 * `inputRef` is the composer's own handle: a landed listing re-dispatches a
 * synthetic `input` through it, which only fires while THIS composer's
 * editable is focused.
 */
export function useAtMentions(
  agents: DurableView["agents"],
  inputRef: RefObject<ChatPromptInputHandle | null>,
  files?: MentionFiles,
): ChatComposerTrigger[] | undefined {
  const roles = agents?.roles ?? [];
  const [listings, setListings] = useState<Listings>({ byKey: {} });
  // The latest `files` prop is read through a ref so callers may pass inline
  // closures — what must invalidate the cache (the scope key) is part of the
  // key itself, not of the closure's identity.
  const filesRef = useRef(files);
  filesRef.current = files;
  const fetcherRef = useRef<ReturnType<typeof createMentionFetcher> | undefined>(undefined);
  fetcherRef.current ??= createMentionFetcher((cacheKey, scopeKey, files) => {
    setListings((current) => {
      const now = Date.now();
      const byKey: Record<string, AnsweredListing> = {};
      // Expired entries are dropped on write too, so the map can't grow
      // without bound over a long session.
      for (const [key, entry] of Object.entries(current.byKey)) {
        if (now - entry.at < MENTION_LISTING_TTL_MS) byKey[key] = entry;
      }
      byKey[cacheKey] = { files, at: now };
      return { byKey, latest: { scope: scopeKey, files } };
    });
  });
  useEffect(() => () => fetcherRef.current?.cancel(), []);
  // Astryx only re-runs `search` on an input event — a state update alone
  // reaches the menu via a NEW trigger object, but nothing calls back into
  // `handleInput`. `emitInput` gives the focused editable a synthetic `input`
  // so the still-active @ span re-activates against the new trigger and
  // merges the landed files; when focus is elsewhere (or in a sibling
  // composer) the next real keystroke does it instead.
  useEffect(() => {
    if (listings.latest === undefined) return;
    inputRef.current?.emitInput();
  }, [listings]);

  const filesEnabled = files !== undefined;
  return useMemo(() => {
    if (roles.length === 0 && !filesEnabled) return undefined;
    const fetcher = fetcherRef.current!;
    const searchSource: SearchSource = {
      bootstrap: () => [],
      search: (query) => {
        const needle = query.toLowerCase();
        const agentItems = roles.filter((role) => role.name.includes(needle)).map(agentItem);
        const source = filesRef.current;
        if (source === undefined) return agentItems;
        // `@./x` narrows to files — a role name can't hold "/" or ".".
        const fileQuery = query.startsWith("./") ? query.slice(2) : query;
        const cacheKey = mentionCacheKey(source.key, fileQuery);
        const answered = listings.byKey[cacheKey];
        if (answered !== undefined && Date.now() - answered.at < MENTION_LISTING_TTL_MS) {
          return [...agentItems, ...answered.files.map(fileItem)];
        }
        fetcher.request(cacheKey, source.key, () => source.list(fileQuery));
        // The new query hasn't answered: keep the previous same-scope
        // candidates on screen rather than collapsing the Files group on
        // every keystroke; a different scope's paths are never shown.
        if (listings.latest !== undefined && listings.latest.scope === source.key) {
          return [...agentItems, ...listings.latest.files.map(fileItem)];
        }
        return agentItems;
      },
      cancel: () => fetcher.cancel(),
    };
    const label = roles.length > 0 && filesEnabled ? "Agents and files" : roles.length > 0 ? "Named agents" : "Files";
    return [
      {
        character: "@",
        searchSource,
        menuLabel: label,
        emptySearchResultsText: `No matching ${roles.length > 0 && filesEnabled ? "agents or files" : roles.length > 0 ? "agents" : "files"}`,
        renderItem: (item) => {
          const aux = auxOf(item);
          const Icon = aux?.kind === "file" ? FileIcon : Bot;
          return (
            <span className="flex w-full min-w-0 items-center gap-2">
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className={`truncate ${aux?.description === undefined ? "min-w-0" : "max-w-[60%] shrink-0"}`}>{item.label}</span>
                {aux?.description === undefined ? null : (
                  <span className="min-w-0 truncate text-xs text-muted">{aux.description}</span>
                )}
              </span>
            </span>
          );
        },
        // Plain text, not a token: the host never parses the mention, and the
        // message must survive being copied into an ordinary prompt.
        onSelect: (item) => auxOf(item)?.insert ?? "",
      },
    ];
  }, [roles, listings, filesEnabled]);
}
