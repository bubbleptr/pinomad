import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { fakeRemote, PINOMAD, TASK, WEBSITE, withInbox } from "../../test/story-fixtures.tsx";
import { InboxScreen } from "./inbox-screen.tsx";

const view = withInbox();

const meta = {
  title: "Widgets/Inbox/InboxScreen",
  component: InboxScreen,
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] flex-col">
        <Story />
      </div>
    ),
  ],
  args: { view, remote: fakeRemote(view), target: { project: WEBSITE.path }, onOpened: fn() },
} satisfies Meta<typeof InboxScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A project's intake before its first message: sending it opens the intake (ADR-0051 §6). */
export const IntakeDraft: Story = {};

/** A task the worker has not taken yet: its event, its place in the queue, and Skip. */
export const QueuedTask: Story = { args: { target: { project: PINOMAD.path, task: TASK.queuedSecond } } };
