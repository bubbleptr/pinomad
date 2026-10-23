import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { ModelSelector } from "./model-selector.tsx";

const models: ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-a", name: "Claude A", contextWindow: 200_000, thinkingLevels: ["off", "medium", "high"] },
  { provider: "openai", modelId: "gpt-b", name: "GPT B", contextWindow: 400_000, thinkingLevels: ["off", "low", "medium"] },
  { provider: "local", modelId: "llama-c", name: "Llama C", contextWindow: 128_000, thinkingLevels: ["off"] },
];

const roles: AgentRole[] = [
  { name: "reviewer", description: "Reads the diff against the repo's ADRs and flags what breaks them.", prompt: "Be thorough." },
  { name: "planner", description: "Turns a request into an ordered plan before any code changes.", prompt: "Be concise." },
  { name: "release-notes", description: "Writes user-facing notes from merged PRs.", prompt: "" },
];

const open = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByTestId("model-thinking-trigger"));
};

const meta = {
  title: "Entities/Model/ModelSelector",
  component: ModelSelector,
  args: {
    models,
    selected: { model: { provider: "anthropic", modelId: "claude-a" }, level: "medium" },
    onModelChange: fn(),
    onLevelChange: fn(),
  },
} satisfies Meta<typeof ModelSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Reasoning: Story = {};

export const NonReasoning: Story = {
  args: { selected: { model: { provider: "local", modelId: "llama-c" }, level: "off" } },
};

export const FromAgent: Story = {
  args: { sourceHint: "from @reviewer" },
};

export const Problem: Story = {
  args: {
    problem: {
      label: "anthropic/claude-z unavailable",
      title: "anthropic/claude-z (@reviewer's model) is not in the host's model list",
    },
  },
};

export const NoModels: Story = {
  args: { models: [], selected: { level: "off" } },
};

export const Open: Story = { play: open };

/** A draft on a host with named agents: the Agent section leads the popover. */
export const AgentPick: Story = {
  args: { agent: { kind: "pick", roles, value: undefined, onChange: fn() } },
  play: open,
};

/** A picked agent prefixes the capsule; the inherited side reads "from @name". */
export const AgentPicked: Story = {
  args: { agent: { kind: "pick", roles, value: "reviewer", onChange: fn() }, sourceHint: "from @reviewer" },
};

export const AgentPickedOpen: Story = { ...AgentPicked, play: open };

/** A conversation on a 5.18 host: the current agent is picked like a draft's. */
export const ConversationAgentPick: Story = {
  args: { agent: { kind: "pick", roles, value: "reviewer", onChange: fn() } },
  play: open,
};

/** The conversation's current agent file is gone: still shown as selected, not offered again. */
export const ConversationAgentMissing: Story = {
  args: { agent: { kind: "pick", roles, value: "retired", onChange: fn() } },
  play: open,
};

/** A pre-5.18 host has no setAgent: the creation agent stays a read-only row. */
export const FixedRole: Story = {
  args: { agent: { kind: "fixed", name: "reviewer", description: roles[0]!.description } },
  play: open,
};
