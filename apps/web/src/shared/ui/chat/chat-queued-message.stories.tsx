import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatQueuedMessage } from "./chat-queued-message.tsx";

const meta = {
  title: "Shared/Chat/ChatQueuedMessage",
  component: ChatQueuedMessage,
  args: {
    body: "Also run the Playwright suite once the unit tests pass.",
    tag: "Steer",
    style: { maxWidth: 480 },
  },
} satisfies Meta<typeof ChatQueuedMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Steer: Story = {};

export const FollowUp: Story = {
  args: { body: "Then open a PR against main.", tag: "Follow-up" },
};

export const LongBodyTruncates: Story = {
  args: {
    body: "After the parser fix lands, regenerate the Rust vectors for both the protocol and client projects, rerun cargo test with the ffi feature, and summarize any drift you find in the freshness test output.",
    tag: "Follow-up",
    style: { maxWidth: 320 },
  },
};
