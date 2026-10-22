import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  busyConversation,
  fakeView,
  forkConversation,
  PARSER_ID,
  settledConversation,
  subagentConversation,
  summaryOf,
} from "../../test/story-fixtures.tsx";
import { ConversationTranscript } from "./conversation-transcript.tsx";

const meta = {
  title: "Widgets/Chat/ConversationTranscript",
  component: ConversationTranscript,
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100vh-3rem)] flex-col">
        <Story />
      </div>
    ),
  ],
  args: {
    conversation: settledConversation(),
    toolPresentations: {},
    connected: true,
    canFork: true,
    openInPanel: fn(),
    onFork: fn(),
    summaryOf,
    docs: fakeView().docs,
    skillNames: ["review"],
    onRetry: fn(async () => {}),
  },
} satisfies Meta<typeof ConversationTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Settled: Story = {};

export const Running: Story = { args: { conversation: busyConversation() } };

/** A fork beside its parent shows only its own entries, under a divider naming the parent. */
export const ForkOwnEntries: Story = {
  args: { conversation: forkConversation(), ownOnly: true, forkSource: summaryOf(PARSER_ID)?.title, docs: [] },
};

/** A subagent's transcript is read-only: no forking, no retry. */
export const Subagent: Story = {
  args: { conversation: subagentConversation(), canFork: false, onRetry: undefined, docs: [] },
};
