import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView, ModelSummary } from "@pinomad/protocol/view.ts";
import { AgentEditorDialog } from "./agent-editor-dialog.tsx";

const models: ModelSummary[] = [
  {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 200_000,
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
  },
  { provider: "openai", modelId: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128_000, thinkingLevels: ["off"] },
];

// The dialog reads only the host's model list off the view.
const view = { models } as unknown as DurableView;

const remote = {
  controller: { createAgent: fn(async () => {}), updateAgent: fn(async () => {}) },
} as unknown as RemoteDurable;

const meta = {
  title: "Widgets/AppFrame/AgentEditorDialog",
  component: AgentEditorDialog,
  args: { view, remote, connected: true, onClose: fn() },
} satisfies Meta<typeof AgentEditorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewAgent: Story = {};

export const EditPinned: Story = {
  args: {
    role: {
      name: "reviewer",
      description: "Reviews a diff against the repo's ADRs and conventions",
      model: "anthropic/claude-opus-5-5",
      thinkingLevel: "high",
      prompt: "Read the diff, then the ADRs it touches. Report findings by severity.",
    },
  },
};

// A pin the host no longer offers stays selectable instead of silently dropping.
export const UnavailableModel: Story = {
  args: {
    role: { name: "legacy", description: "Old pinned role", model: "openai/gpt-4o", prompt: "" },
  },
};
