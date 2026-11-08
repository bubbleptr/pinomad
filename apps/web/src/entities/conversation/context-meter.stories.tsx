import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextBar } from "./context-meter.tsx";

const meta = {
  title: "Entities/Conversation/ContextBar",
  component: ContextBar,
  decorators: [
    // The Usage section's width inside the overview card.
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
  args: { usage: { used: 84_000, window: 200_000 }, breakdown: undefined },
} satisfies Meta<typeof ContextBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No breakdown (an older host, or the reply not broken down yet): one fill. */
export const Plain: Story = {};

export const Breakdown: Story = {
  args: { breakdown: { used: 84_000, system: 6_200, skills: 2_400, tools: 9_800, mcp: 4_100, messages: 61_500 } },
};

export const NearLimit: Story = {
  args: { usage: { used: 172_000, window: 200_000 } },
};

/** After a swap to a smaller model: the bar fills to the total. */
export const OverWindow: Story = {
  args: { usage: { used: 250_000, window: 200_000 } },
};

export const Unknown: Story = {
  args: { usage: undefined },
};
