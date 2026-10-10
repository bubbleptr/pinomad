// Fills ChatToolItem.detail from the adapter's `pinomad` payload — the one
// piece of tool rendering that needs React. deriveChat stays React-free and
// testable. (Subagent calls never reach the CoT: splitSubagentCalls lifts
// them into the run's anchor cards.)
import type { CotView, PinomadToolDetail } from "@/entities/conversation/cot-view";
import { pinomadOf } from "@/entities/conversation/cot-view";
import { DiffView } from "@/presentation/diff.tsx";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import type { ReactNode } from "react";

function detailOf(pinomad: PinomadToolDetail): ReactNode {
  return pinomad.kind === "diff" ? <DiffView patch={pinomad.patch} /> : undefined;
}

/** The same view with every tool item's `pinomad` payload rendered into `detail`. */
export function fillToolDetails(view: CotView): CotView {
  const fill = (tool: ChatToolItem): ChatToolItem => {
    const pinomad = pinomadOf(tool);
    const detail = pinomad === undefined ? undefined : detailOf(pinomad);
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
