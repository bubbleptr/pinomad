import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { AgentRole } from "@pinomad/protocol/agents.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { ModelSelector } from "./model-selector.tsx";

const models: ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-a", name: "Claude A", contextWindow: 200_000, thinkingLevels: ["off", "medium", "high"] },
  { provider: "anthropic", modelId: "claude-a-max", name: "Claude A Max", contextWindow: 1_000_000, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "openai", modelId: "gpt-b", name: "GPT B", contextWindow: 400_000, thinkingLevels: ["off", "low", "medium"] },
  { provider: "local", modelId: "llama-c", name: "Llama C", contextWindow: 128_000, thinkingLevels: ["off"] },
  // The maker's logo, not OpenRouter's; then a model with no logo at all, whose row keeps the logo slot.
  { provider: "openrouter", modelId: "moonshotai/kimi-d", name: "Kimi D", contextWindow: 256_000, thinkingLevels: ["off"] },
  { provider: "custom-lab", modelId: "house-e", name: "House E", contextWindow: 32_000, thinkingLevels: ["off"] },
];

const roles: AgentRole[] = [
  { name: "reviewer", description: "Reads the diff against the repo's ADRs and flags what breaks them.", model: "anthropic/claude-a", thinkingLevel: "high", prompt: "Be thorough." },
  { name: "planner", description: "Turns a request into an ordered plan before any code changes.", prompt: "Be concise." },
  { name: "release-notes", description: "Writes user-facing notes from merged PRs.", model: "gone/claude-z", prompt: "" },
];

const problems = [{ file: "drafty.md", reason: "description is required" }];

const open = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByTestId("model-trigger"));
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

/** The Thinking capsule's popover: the selected model's levels, strongest first. */
export const ThinkingOpen: Story = {
  args: { selected: { model: { provider: "anthropic", modelId: "claude-a-max" }, level: "high" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId("thinking-trigger"));
  },
};

const openAgents = async (context: { canvasElement: HTMLElement }) => {
  await open(context);
  await userEvent.click(within(document.body).getByRole("button", { name: /^Agent:/ }));
};

/** A draft on a host with named agents: the Agent row leads the popover. */
export const AgentPick: Story = {
  args: { agent: { kind: "pick", roles, problems, value: undefined, onChange: fn() } },
  play: open,
};

/** The agent list one level down: pins, an unavailable model and a broken file. */
export const AgentList: Story = { ...AgentPick, play: openAgents };

/** An agent that pins model and level: "from @name", and both sides locked. */
export const AgentPicked: Story = {
  args: {
    agent: { kind: "pick", roles, problems, value: "reviewer", onChange: fn() },
    selected: { model: { provider: "anthropic", modelId: "claude-a" }, level: "high" },
    locked: { model: true, level: true },
  },
};

export const AgentPickedOpen: Story = { ...AgentPicked, play: open };

/** An agent that pins nothing: "with @name", and both sides stay the user's. */
export const AgentUnpinned: Story = {
  args: { agent: { kind: "pick", roles, value: "planner", onChange: fn() } },
};

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
