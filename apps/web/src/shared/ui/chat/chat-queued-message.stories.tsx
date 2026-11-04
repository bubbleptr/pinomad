import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ChatQueuedMessage } from "./chat-queued-message.tsx";

const meta = {
  title: "Shared/Chat/ChatQueuedMessage",
  component: ChatQueuedMessage,
  args: {
    body: "Also run the Playwright suite once the unit tests pass.",
    mode: "followUp",
    reorder: { onMoveUp: fn(), onMoveDown: fn() },
    onSteer: fn(),
    onEdit: fn(),
    onWithdraw: fn(),
    style: { maxWidth: 480 },
  },
} satisfies Meta<typeof ChatQueuedMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FollowUp: Story = {};

/** A steer keeps its ⇪ mark in the column where Steer now was. */
export const Steer: Story = {
  args: { body: "Use the existing date helper instead.", mode: "steer", onSteer: undefined },
};

export const Dragging: Story = { args: { dragState: "dragging" } };

export const DropBefore: Story = { args: { dragState: "before" } };

export const LocalNotConfirmed: Story = {
  args: {
    isLocal: true,
    reorder: undefined,
    status: <span className="text-muted">Not confirmed</span>,
    onSteer: undefined,
    onEdit: undefined,
    onWithdraw: undefined,
    onRetry: fn(),
  },
};

export const LocalFailed: Story = {
  args: {
    isLocal: true,
    reorder: undefined,
    status: <span className="text-danger">Failed to send</span>,
    onSteer: undefined,
    onWithdraw: undefined,
    onRetry: fn(),
  },
};

export const LongBodyTruncates: Story = {
  args: {
    body: "After the parser fix lands, regenerate the Rust vectors for both the protocol and client projects, rerun cargo test with the ffi feature, and summarize any drift you find in the freshness test output.",
    style: { maxWidth: 320 },
  },
};
