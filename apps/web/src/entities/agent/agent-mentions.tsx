// The `@` mention menu (ADR-0023 §4): one trigger per composer, built from the
// host's `agents` stream. Selecting inserts plain `@name ` text — the host does
// nothing special; the `agent_roles` system-prompt section already tells the
// model to delegate on @name.
import { useMemo } from "react";
import type { ChatComposerTrigger, ChatComposerTriggerItem } from "@astryxdesign/core/Chat";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

const toItem = (role: AgentRole): ChatComposerTriggerItem => ({
  id: role.name,
  label: role.name,
  auxiliaryData: { description: role.description },
});

/**
 * The trigger list for `ChatPromptInput`'s `triggers` prop, or undefined.
 * Undefined matters: with triggers configured Astryx turns the editable into
 * role="combobox", and an empty roles list would surface a "No results" popup
 * on every stray `@`. `view.agents === null` means the host predates 5.6.
 */
export function useAgentMentions(agents: DurableView["agents"]): ChatComposerTrigger[] | undefined {
  const roles = agents?.roles ?? [];
  return useMemo(() => {
    if (roles.length === 0) return undefined;
    const items = roles.map(toItem);
    const searchSource: SearchSource = {
      bootstrap: () => items,
      search: (query) => {
        const needle = query.toLowerCase();
        return items.filter((item) => item.id.includes(needle));
      },
    };
    return [
      {
        character: "@",
        searchSource,
        menuLabel: "Named agents",
        emptySearchResultsText: "No matching agents",
        renderItem: (item) => {
          const description = (item.auxiliaryData as { description?: string } | undefined)?.description;
          return (
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{item.id}</span>
              {description === undefined ? null : (
                <span className="truncate text-xs text-muted">{description}</span>
              )}
            </span>
          );
        },
        // Plain text, not a token: the host never parses the mention, and the
        // message must survive being copied into an ordinary prompt.
        onSelect: (item) => `@${item.id} `,
      },
    ];
  }, [roles]);
}
