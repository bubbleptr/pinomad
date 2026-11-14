// Fills ChatToolItem.detail from the adapter's `pinomad` payload, or from a
// plugin's card for that tool name (ADR-0049) — the one piece of tool
// rendering that needs React. deriveChat stays React-free and testable.
// (Subagent calls never reach the CoT: splitSubagentCalls lifts them into the
// run's anchor cards.)
import type { CotView, PinomadToolDetail } from "@pinomad/client/cot-view.ts";
import { pinomadOf } from "@pinomad/client/cot-view.ts";
import type { ToolItem } from "@pinomad/client/tool-item.ts";
import { DiffView } from "@/presentation/diff.tsx";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import type { ReactNode } from "react";
import type { JsonValue } from "@pinomad/plugin/v1/web";
import { EMPTY_PLUGIN_REGISTRY, type PluginToolCard } from "@/entities/plugin/load-plugins.ts";
import { PluginSlot } from "@/entities/plugin/plugin-host.tsx";

function detailOf(pinomad: PinomadToolDetail): ReactNode {
  return pinomad.kind === "diff" ? <DiffView patch={pinomad.patch} /> : undefined;
}

/** Arguments still streaming in, or not JSON, are undefined. */
function parsedArgs(argsText: string | undefined): JsonValue | undefined {
  if (argsText === undefined) return undefined;
  try {
    return JSON.parse(argsText) as JsonValue;
  } catch {
    return undefined;
  }
}

function pluginDetail(tool: ToolItem, card: PluginToolCard): ReactNode {
  const Card = card.component;
  return (
    // Keyed by bundle, so a card that failed to render tries again once its plugin is reloaded.
    <PluginSlot key={card.hash} plugin={card.plugin}>
      <Card tool={{ name: tool.toolName ?? "", args: parsedArgs(tool.argsText), output: tool.output, state: tool.state }} />
    </PluginSlot>
  );
}

/**
 * The same view with every tool item's `pinomad` payload, or else a plugin's
 * card for its tool name, rendered into `detail`.
 */
export function fillToolDetails(
  view: CotView,
  pluginCards: ReadonlyMap<string, PluginToolCard> = EMPTY_PLUGIN_REGISTRY.toolCards,
): CotView {
  const fill = (tool: ToolItem): ChatToolItem => {
    const pinomad = pinomadOf(tool);
    const card = tool.toolName === undefined ? undefined : pluginCards.get(tool.toolName);
    const detail =
      pinomad !== undefined ? detailOf(pinomad) : card !== undefined ? pluginDetail(tool, card) : undefined;
    const children = tool.children?.map(fill);
    if (detail === undefined && children === undefined) return tool;
    return {
      ...tool,
      ...(detail === undefined ? {} : { detail }),
      ...(children === undefined ? {} : { children }),
    };
  };
  return {
    ...view,
    steps: view.steps.map((step) =>
      step.kind === "tools" ? { ...step, tools: step.tools.map(fill) } : step,
    ),
  };
}
