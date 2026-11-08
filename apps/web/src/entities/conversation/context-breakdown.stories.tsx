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
    breakdown: { used: 124_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 9_600, messages: 91_100 },
    window: 200_000,
  },
} satisfies Meta<typeof ContextBreakdownList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A fresh conversation without MCP servers: the fixed parts dominate, MCP has no row. */
export const EarlyNoMcp: Story = {
  args: { breakdown: { used: 21_000, system: 8_100, skills: 3_200, tools: 7_400, mcp: 0, messages: 2_300 } },
};

/** After a swap to a smaller model: the bar fills to the total, shares pass 100% together. */
export const OverWindow: Story = {
  args: { breakdown: { used: 250_000, system: 8_100, skills: 3_200, tools: 12_000, mcp: 9_600, messages: 217_100 }, window: 200_000 },
};
