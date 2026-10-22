// The `/` command menu (issue #254, ADR-0027): host-declared commands that
// run on the host and never reach the model. The list comes only from
// `listCommands`, cached per conversation like the `$` skills.
//
// A command is recognized only at index 0 of the draft, but Astryx's
// `useTriggerMenu` activates a trigger after any whitespace — `see /etc/hosts`
// would pop a menu. So the `/` trigger exists only while the whole draft is
// still a leading `/` plus its first token; once anything else is typed there
// is no `/` trigger for Astryx to match at all.
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CommandInfo, CommandListing } from "@pinomad/protocol/commands.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { ListingCache, useCachedListing } from "@/shared/listing-cache";
import type { ChatPromptInputHandle } from "@/shared/ui/chat/chat-prompt-input";
import { CommandLine } from "@/shared/ui/icons";

type CommandCache = ListingCache<ConversationId, CommandListing, CommandInfo>;

// The connection owns the cache, as for skills: a reconnect shares entries.
const caches = new WeakMap<RemoteDurable, CommandCache>();

function commandCacheFor(remote: RemoteDurable): CommandCache {
  let cache = caches.get(remote);
  if (cache === undefined) {
    cache = new ListingCache(
      (id: ConversationId) => remote.controller.listCommands(id),
      (id) => `conversation:${id}`,
      (listing) => listing.commands,
    );
    caches.set(remote, cache);
  }
  return cache;
}

/** The draft is a leading `/` and at most its first token — the only time the `/` menu may open. */
export const atCommandStart = (value: string): boolean => /^\/\P{White_Space}*$/u.test(value);

/** The listed commands whose name starts with `query`, in the host's order. */
export function commandItems(commands: readonly CommandInfo[], query: string): ChatComposerTriggerItem[] {
  return commands
    .filter((command) => command.name.startsWith(query))
    .map((command) => ({ id: `command:${command.name}`, label: command.name, auxiliaryData: command }));
}

/**
 * The conversation's `/` trigger (only while `value` is at a command start),
 * its listed commands for send-time recognition (undefined until the first
 * listing lands, or on a pre-5.15 host), and `request` for a focus refresh.
 */
export function useSlashCommands(
  remote: RemoteDurable,
  conversationId: ConversationId,
  inputRef: RefObject<ChatPromptInputHandle | null>,
  enabled: boolean,
  value: string,
): {
  readonly trigger: ChatComposerTrigger | undefined;
  readonly commands: readonly CommandInfo[] | undefined;
  readonly request: () => void;
} {
  const { items: commands, request } = useCachedListing(commandCacheFor(remote), conversationId, enabled);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const requestRef = useRef(request);
  requestRef.current = request;
  const active = enabled && atCommandStart(value);
  const trigger = useMemo<ChatComposerTrigger | undefined>(() => {
    if (!active) return undefined;
    // What the user typed after `/`, so picking a disabled command can put it back.
    let typed = "";
    const searchSource: SearchSource = {
      bootstrap: () => [],
      // Sync array like the `$` source; a stale listing refetches while its answer keeps showing.
      search: (query) => {
        typed = query;
        requestRef.current();
        return commandItems(commandsRef.current ?? [], query);
      },
      cancel: () => {},
    };
    return {
      character: "/",
      searchSource,
      menuLabel: "Commands",
      emptySearchResultsText: "No matching commands",
      renderItem: (item) => {
        const command = item.auxiliaryData as CommandInfo;
        return (
          <span
            aria-disabled={command.disabled === undefined ? undefined : true}
            className={`flex min-w-0 items-center gap-2 ${command.disabled === undefined ? "" : "opacity-50"}`}
          >
            <CommandLine aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block truncate">
                /{command.name}
                {command.argumentHint === undefined ? null : <span className="text-muted"> {command.argumentHint}</span>}
              </span>
              <span className="block truncate text-xs text-muted">{command.disabled ?? command.description}</span>
            </span>
          </span>
        );
      },
      // A disabled command can't be picked: the typed text goes back as it was.
      onSelect: (item) => {
        const command = item.auxiliaryData as CommandInfo;
        return command.disabled === undefined ? `/${command.name} ` : `/${typed}`;
      },
    };
    // A landed listing rebuilds the trigger so Astryx's next search reads it.
  }, [active, commands]);
  // The trigger appears on the keystroke that typed the `/`, after Astryx has
  // already looked for one; a synthetic input lets it see the new trigger
  // (and, when a listing lands, re-run the search).
  useEffect(() => {
    if (trigger !== undefined) inputRef.current?.emitInput();
  }, [trigger, inputRef]);
  return { trigger, commands, request };
}
