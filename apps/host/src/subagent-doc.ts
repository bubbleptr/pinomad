// The subagent's label: the `description` its delegating call gave.
// extensions/subagent.ts writes it in the commit that creates the child; the
// gateway's conversation list reads it to fill ConversationSummary.label. It
// lives in core because only the composition root may import extensions/.
import { defineDoc } from "@earendil-works/pi-durable";

export const SubagentDoc = defineDoc<{ label?: string }>({
  kind: "pinomad.subagent",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
