import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  busyConversation,
  fakeView,
  forkConversation,
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
    onOpenFork: fn(),
    onFork: fn(),
    summaryOf,
    docs: fakeView().docs,
    onRetry: fn(async () => {}),
  },
} satisfies Meta<typeof ConversationTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Settled: Story = {};

export const Running: Story = { args: { conversation: busyConversation() } };

/** A fork in main is an ordinary conversation: no Fork action at depth one. */
export const Fork: Story = {
  args: { conversation: forkConversation(), canFork: false, docs: [] },
};

/** A subagent's transcript: no forking, no retry. */
export const Subagent: Story = {
  args: { conversation: subagentConversation(), canFork: false, onRetry: undefined, docs: [] },
};
