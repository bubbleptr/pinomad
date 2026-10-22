import type { Meta, StoryObj } from "@storybook/react-vite";
import { PinomadMark } from "./pinomad-mark.tsx";

const meta = {
  title: "Shared/PinomadMark",
  component: PinomadMark,
  args: { width: 64, height: 64 },
} satisfies Meta<typeof PinomadMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InheritsTextColor: Story = {
  render: (args) => (
    <span style={{ color: "var(--color-accent)" }}>
      <PinomadMark {...args} />
    </span>
  ),
};
