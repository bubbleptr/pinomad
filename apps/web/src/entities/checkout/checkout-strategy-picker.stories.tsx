import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CheckoutStrategyPicker } from "./checkout-strategy-picker.tsx";

const meta = {
  title: "Entities/Checkout/CheckoutStrategyPicker",
  component: CheckoutStrategyPicker,
  args: { value: "worktree", onChange: fn() },
} satisfies Meta<typeof CheckoutStrategyPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Worktree: Story = {};

export const ProjectFolder: Story = {
  args: { value: "local" },
};

export const Disabled: Story = {
  args: { isDisabled: true },
};
