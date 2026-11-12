import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ChatLayoutScrollButton } from "./chat-layout-scroll-button";

const meta = {
  title: "Shared/ChatKit/ChatLayoutScrollButton",
  component: ChatLayoutScrollButton,
  args: { isVisible: true, onClick: fn() },
} satisfies Meta<typeof ChatLayoutScrollButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NewMessages: Story = { args: { label: "New messages" } };
