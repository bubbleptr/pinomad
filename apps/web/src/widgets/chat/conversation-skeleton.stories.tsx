import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { fn } from "storybook/test";
import { ComposerSkeleton, ConversationSkeleton, ConversationUnavailable } from "./conversation-skeleton.tsx";

/** The main column while an opened conversation loads, as App lays it out. */
const meta = {
  title: "Widgets/Chat/ConversationSkeleton",
  component: ConversationSkeleton,
  render: () => (
    <div className="flex h-[36rem] flex-col">
      <ChatLayout
        style={{ flex: 1, minHeight: 0 }}
        composer={
          <div className="mx-auto w-full max-w-[44rem]">
            <ComposerSkeleton />
          </div>
        }
      >
        <ConversationSkeleton />
      </ChatLayout>
    </div>
  ),
} satisfies Meta<typeof ConversationSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {};

/** The switch settled without the conversation: the host ended it or the connection dropped. */
export const Failed: StoryObj<typeof ConversationUnavailable> = {
  render: (args) => <ConversationUnavailable {...args} />,
  args: { missing: false, connected: true, onRetry: fn() },
};

export const FailedOffline: StoryObj<typeof ConversationUnavailable> = {
  ...Failed,
  args: { ...Failed.args, connected: false },
};

/** Gone from the host's list — archived or deleted elsewhere — so there is nothing to retry. */
export const Missing: StoryObj<typeof ConversationUnavailable> = {
  ...Failed,
  args: { ...Failed.args, missing: true },
};
