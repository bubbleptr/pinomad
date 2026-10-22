import type { Meta, StoryObj } from "@storybook/react-vite";
import { busyConversation, fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { ConversationComposer } from "./conversation-composer.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/Composer/ConversationComposer",
  component: ConversationComposer,
  decorators: [
    // It sits at the foot of the chat column.
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] flex-col justify-end">
        <Story />
      </div>
    ),
  ],
  args: { view, remote: fakeRemote(view), conversation: view.conversation!, busy: false, narrow: false },
} satisfies Meta<typeof ConversationComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

/** Running, with a steer and a follow-up queued behind the run. */
export const BusyWithQueue: Story = { args: { conversation: busyConversation(), busy: true } };

export const Disconnected: Story = {
  args: { view: fakeView({ connection: "reconnecting" }) },
};

export const Narrow: Story = { args: { narrow: true } };
