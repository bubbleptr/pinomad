// The subagent's label (the `description` its delegating call gave), its
// effective model as "provider/modelId", the named agent it ran as (ADR-0023),
// the epoch-ms it was created, its family-unique name, and its lifecycle class
// (ADR-0046 §6: a foreground one turns background, once, when it first runs
// outside its call).
// The subagent tools write it in the commit that creates the child; the
// gateway's conversation list reads it to fill ConversationSummary. It lives
// in core because only the composition root may import extensions/.
import { defineDoc } from "@earendil-works/pi-durable";

export const SubagentDoc = defineDoc<{
  label?: string;
  model?: string;
  startedAt?: number;
  role?: string;
  name?: string;
  lifecycle?: "foreground" | "background";
}>({
  kind: "pinomad.subagent",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => false,
});
