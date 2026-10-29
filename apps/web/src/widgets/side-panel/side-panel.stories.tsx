import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  fakeRemote,
  fakeView,
  FORK_ID,
  forkConversation,
  PARSER_ID,
  SUBAGENT_ID,
  subagentConversation,
} from "../../test/story-fixtures.tsx";
import { SidePanel } from "./side-panel.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/SidePanel/SidePanel",
  component: SidePanel,
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: { canvasWidth: "full" },
  args: {
    view,
    remote: fakeRemote(view),
    shownId: PARSER_ID,
    narrow: false,
    open: true,
    onOpenChange: fn(),
    tab: "threads",
    onTabChange: fn(),
    openInPanel: fn(),
    onOpenInMain: fn(),
  },
} satisfies Meta<typeof SidePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Threads: Story = {};

export const Tasks: Story = { args: { tab: "tasks" } };

/** A fork opened beside its parent: its own entries and a composer of its own. */
const withFork = fakeView({ side: { id: FORK_ID, conversation: forkConversation(), docs: [] } });
export const ThreadDetail: Story = { args: { view: withFork, remote: fakeRemote(withFork) } };

/** A follow-up queued in the side panel that the host refused; it stays local. */
const withFailedFollowUp = fakeView({
  side: { id: FORK_ID, conversation: forkConversation(), docs: [] },
  submissions: [
    {
      requestId: "side-follow-up",
      conversationId: FORK_ID,
      text: "Follow up with the release notes",
      whenBusy: "followUp",
      placement: "queue",
      phase: "failed",
      images: [],
      skills: [],
      attachments: [],
      error: "The host refused this follow-up.",
    },
  ],
});
export const FailedFollowUp: Story = {
  args: { view: withFailedFollowUp, remote: fakeRemote(withFailedFollowUp) },
};

/** A running subagent's transcript, read-only. */
const withSubagent = fakeView({ side: { id: SUBAGENT_ID, conversation: subagentConversation(), docs: [] } });
export const TaskDetail: Story = { args: { view: withSubagent, remote: fakeRemote(withSubagent), tab: "tasks" } };

/** While drafting there is no family to list. */
export const Drafting: Story = { args: { shownId: undefined } };

/** On a phone the panel is a fullscreen dialog. */
export const Narrow: Story = { args: { narrow: true } };
