import type { Meta, StoryObj } from "@storybook/react-vite";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { InboxQuietHours } from "./inbox-quiet-hours.tsx";

const off = fakeView();
const on = fakeView({ settings: { ...off.settings!, inboxQuietHours: { start: 22 * 60, end: 7 * 60 + 30 } } });

const meta = {
  title: "Widgets/AppFrame/InboxQuietHours",
  component: InboxQuietHours,
  decorators: [
    (Story) => (
      <div className="pigui-settings">
        <Story />
      </div>
    ),
  ],
  args: { view: off, remote: fakeRemote(off) },
} satisfies Meta<typeof InboxQuietHours>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No quiet hours: Inbox updates push as they come. */
export const Off: Story = {};

/** Overnight, in the host's local time. */
export const On: Story = { args: { view: on, remote: fakeRemote(on) } };
