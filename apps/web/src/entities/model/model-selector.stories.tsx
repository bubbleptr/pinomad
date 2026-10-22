import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import { ModelSelector } from "./model-selector.tsx";

const models: ModelSummary[] = [
  { provider: "anthropic", modelId: "claude-a", name: "Claude A", contextWindow: 200_000, thinkingLevels: ["off", "medium", "high"] },
  { provider: "openai", modelId: "gpt-b", name: "GPT B", contextWindow: 400_000, thinkingLevels: ["off", "low", "medium"] },
  { provider: "local", modelId: "llama-c", name: "Llama C", contextWindow: 128_000, thinkingLevels: ["off"] },
];

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

export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId("model-thinking-trigger"));
  },
};
