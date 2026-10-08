// Fills ChatToolItem.detail from the adapter's `pinomad` payload — the one
// piece of tool rendering that needs React (diff viewers, the subagent card's
// Open button). deriveChat stays React-free and testable.
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import type { ConversationId } from "@earendil-works/pi-durable";
import { pinomadOf, type CotView, type PinomadToolDetail } from "@/entities/conversation/cot-view";
import { DiffView } from "@/presentation/diff.tsx";
import { ChatMarkdown } from "@/shared/ui/chat/chat-markdown";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import type { ReactNode } from "react";

function detailOf(
  pinomad: PinomadToolDetail,
  tool: ChatToolItem,
  openConversation: (id: ConversationId) => void,
): ReactNode {
  if (pinomad.kind === "diff") return <DiffView patch={pinomad.patch} />;
  return (
    <VStack gap={2} hAlign="start">
      <HStack>
        {/* Available while the call still runs: the child's conversation is
            live, and opening it shows the subagent working. */}
        <Button
          label="Open conversation"
          variant="secondary"
          size="sm"
          onClick={() => openConversation(pinomad.conversationId)}
        />
      </HStack>
      {tool.state === "output-error" || pinomad.output === undefined || pinomad.output === "" ? null : (
        <ChatMarkdown>{pinomad.output}</ChatMarkdown>
      )}
    </VStack>
  );
}

/** The same view with every tool item's `pinomad` payload rendered into `detail`. */
export function fillToolDetails(view: CotView, openConversation: (id: ConversationId) => void): CotView {
  const fill = (tool: ChatToolItem): ChatToolItem => {
    const pinomad = pinomadOf(tool);
    const detail = pinomad === undefined ? undefined : detailOf(pinomad, tool, openConversation);
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
