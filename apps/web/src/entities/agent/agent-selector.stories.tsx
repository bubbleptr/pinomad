import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { AgentRoles } from "@pinomad/protocol/agents.ts";
import { AgentSelector } from "./agent-selector.tsx";

const agents: AgentRoles = {
  roles: [
    { name: "reviewer", description: "Reads the diff against the repo's ADRs and flags what breaks them.", prompt: "Be thorough." },
    { name: "planner", description: "Turns a request into an ordered plan before any code changes.", prompt: "Be concise." },
    { name: "release-notes", description: "Writes user-facing notes from merged PRs.", prompt: "" },
  ],
  problems: [],
};

const meta = {
  title: "Entities/Agent/AgentSelector",
  component: AgentSelector,
  args: { agents, value: undefined, onChange: fn() },
} satisfies Meta<typeof AgentSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoAgent: Story = {};

export const Picked: Story = {
  args: { value: "reviewer" },
};

export const Disabled: Story = {
  args: { value: "reviewer", isDisabled: true },
};

export const Open: Story = {
  args: { value: "planner" },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId("agent-trigger"));
  },
};
