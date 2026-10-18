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
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { FileListing } from "@pinomad/protocol/organization.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Bot, FileIcon } from "@/shared/ui/icons";
import { createMentionFetcher, mentionCacheKey } from "./mention-fetcher.ts";

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
 */
export function useAtMentions(
  agents: DurableView["agents"],
  files?: MentionFiles,
): ChatComposerTrigger[] | undefined {
  const roles = agents?.roles ?? [];
  // Answered listings by scope+query key; a missing key means "not asked".
  const [listings, setListings] = useState<Record<string, readonly string[]>>({});
  // The latest `files` prop is read through a ref so callers may pass inline
  // closures — what must invalidate the cache (the scope key) is part of the
  // key itself, not of the closure's identity.
  const filesRef = useRef(files);
  filesRef.current = files;
  const fetcherRef = useRef<ReturnType<typeof createMentionFetcher> | undefined>(undefined);
  fetcherRef.current ??= createMentionFetcher((cacheKey, files) => {
    setListings((current) => ({ ...current, [cacheKey]: files }));
  });
  useEffect(() => () => fetcherRef.current?.cancel(), []);
  // Astryx only re-runs `search` on an input event — a state update alone
  // reaches the menu via a NEW trigger object, but nothing calls back into
  // `handleInput`. The focused editable gets a synthetic `input` so the
  // still-active @ span re-activates against the new trigger and merges the
  // landed files. When focus moved elsewhere the next real keystroke does it.
  useEffect(() => {
    if (Object.keys(listings).length === 0) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable) {
      active.dispatchEvent(new Event("input", { bubbles: true }));
    }
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
        const answered = listings[cacheKey];
        if (answered === undefined) {
          fetcher.request(cacheKey, () => source.list(fileQuery));
          return agentItems;
        }
        return [...agentItems, ...answered.map(fileItem)];
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
            <span className="flex min-w-0 items-center gap-2">
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block truncate">{item.label}</span>
                {aux?.description === undefined ? null : (
                  <span className="block truncate text-xs text-muted">{aux.description}</span>
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
