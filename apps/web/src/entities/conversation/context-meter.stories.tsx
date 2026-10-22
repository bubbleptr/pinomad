import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextMeter } from "./context-meter.tsx";

const meta = {
  title: "Entities/Conversation/ContextMeter",
  component: ContextMeter,
  args: { usage: { used: 84_000, window: 200_000 } },
} satisfies Meta<typeof ContextMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NearLimit: Story = {
  args: { usage: { used: 172_000, window: 200_000 } },
};

/** After a swap to a smaller model: the figure stays honest, the ring saturates. */
export const OverWindow: Story = {
  args: { usage: { used: 250_000, window: 200_000 } },
};

export const MillionTokenWindow: Story = {
  args: { usage: { used: 1_234_000, window: 2_000_000 } },
};

export const Unknown: Story = {
  args: { usage: undefined },
};
