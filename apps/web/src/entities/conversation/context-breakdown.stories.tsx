import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextBreakdownList } from "./context-breakdown.tsx";

const meta = {
  title: "Entities/Conversation/ContextBreakdownList",
  component: ContextBreakdownList,
  decorators: [
    // The Usage section's width inside the overview card.
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
  args: {
    usage: { used: 124_000, window: 200_000 },
    breakdown: { used: 124_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 9_600, messages: 91_100 },
  },
} satisfies Meta<typeof ContextBreakdownList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A fresh conversation without MCP servers: the fixed parts dominate, MCP has no row. */
export const EarlyNoMcp: Story = {
  args: { usage: { used: 21_000, window: 200_000 }, breakdown: { used: 21_000, system: 8_100, skills: 3_200, tools: 7_400, mcp: 0, messages: 2_300 } },
};

/** After a swap to a smaller model: nothing is left, so no Left row. */
export const OverWindow: Story = {
  args: {
    usage: { used: 250_000, window: 200_000 },
    breakdown: { used: 250_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 9_600, messages: 217_100 },
  },
};

/** An older host, or the reply not broken down yet: only what is left. */
export const NoBreakdown: Story = {
  args: { breakdown: undefined },
};
