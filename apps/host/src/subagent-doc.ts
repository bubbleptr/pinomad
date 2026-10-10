// The subagent's label (the `description` its delegating call gave), its
// effective model as "provider/modelId", and the epoch-ms it was created.
// extensions/subagent.ts writes it in the commit that creates the child and
// reads it back on a rerun; the gateway's conversation list reads the label
// to fill ConversationSummary.label. It lives in core because only the
// composition root may import extensions/.
import { defineDoc } from "@earendil-works/pi-durable";

export const SubagentDoc = defineDoc<{ label?: string; model?: string; startedAt?: number }>({
  kind: "pinomad.subagent",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
