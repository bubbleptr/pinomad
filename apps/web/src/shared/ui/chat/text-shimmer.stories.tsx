import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextShimmer } from "./text-shimmer.tsx";

const meta = {
  title: "Shared/Chat/TextShimmer",
  component: TextShimmer,
  args: { children: "Thinking…" },
} satisfies Meta<typeof TextShimmer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Thinking: Story = {};

export const RunningTool: Story = {
  args: { children: "Running bash…" },
};
