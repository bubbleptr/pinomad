import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { busyConversation, fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { OverviewCard } from "./overview-card.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/Overview/OverviewCard",
  component: OverviewCard,
  decorators: [
    // The card floats over the chat column's top-right corner.
    (Story) => (
      <div className="relative h-[calc(100vh-3rem)]">
        <Story />
      </div>
    ),
  ],
  args: {
    view,
    remote: fakeRemote(view),
    conversation: view.conversation!,
    narrow: false,
    busy: false,
    onOpenChanges: fn(),
    onOpenTasks: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof OverviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Project: Story = {};

export const Busy: Story = { args: { conversation: busyConversation(), busy: true } };

/** Not a git checkout: the Changes row hides, the branch stays when the host sends one. */
export const NoChanges: Story = {
  args: { remote: fakeRemote(view, { changes: async () => ({ available: false, reason: "Not in a git repository" }) }) },
};

const chat = fakeView({ home: { kind: "chat" }, checkout: undefined });
export const Chat: Story = { args: { view: chat, remote: fakeRemote(chat) } };

export const Narrow: Story = { args: { narrow: true } };
