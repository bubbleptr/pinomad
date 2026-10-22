import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationToolItem } from "@pinomad/client/cot-view.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { SubagentCards } from "./subagent-card.tsx";

const id = (n: number): ConversationId => n as ConversationId;
const now = Date.now();

function subagent(
  n: number,
  state: ConversationToolItem["state"],
  description: string,
  timing: { startedAt: number; endedAt?: number },
  output?: string,
): { key: string; tool: ConversationToolItem } {
  return {
    key: `tools-${n}`,
    tool: {
      toolName: "subagent",
      toolCallId: `call-${n}`,
      argsText: JSON.stringify({ description, prompt: "…" }),
      state,
      ...(output === undefined ? {} : { output }),
      pinomad: { kind: "subagent", conversationId: id(n), model: "anthropic/claude-opus-5-5", ...timing },
    },
  };
}

const summaries: Record<number, ConversationSummary> = {
  1: {
    id: id(1),
    kind: "subagent",
    label: "Audit the relay's reconnect path",
    role: "reviewer",
    status: "running",
    activity: { tool: "read", target: "apps/server/src/relay.ts" },
  },
  2: { id: id(2), kind: "subagent", label: "Write migration tests", role: "tester" },
  3: { id: id(3), kind: "subagent", label: "Profile the transcript scroll", status: "failed" },
};

const running = subagent(1, "input-available", "Audit the relay's reconnect path", { startedAt: now - 42_000 });
const done = subagent(2, "output-available", "Write migration tests", { startedAt: now - 200_000, endedAt: now - 125_000 });
const failed = subagent(
  3,
  "output-error",
  "Profile the transcript scroll",
  { startedAt: now - 30_000, endedAt: now - 18_000 },
  "Provider returned 529: overloaded",
);

const meta = {
  title: "Widgets/Chat/SubagentCards",
  component: SubagentCards,
  args: {
    tools: [running, done, failed],
    summaryOf: (conversation: ConversationId) => summaries[conversation as unknown as number],
    openInPanel: fn(),
  },
} satisfies Meta<typeof SubagentCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Running: Story = { args: { tools: [running] } };

// Before the child's summary arrives the card falls back to the call's own arguments.
export const WithoutSummaries: Story = { args: { summaryOf: undefined } };
