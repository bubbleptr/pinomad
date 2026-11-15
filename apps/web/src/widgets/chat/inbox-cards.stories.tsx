import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { fn } from "storybook/test";
import { InboxTranscriptProvider } from "../../entities/inbox/inbox-transcript.tsx";
import {
  inboxTaskConversation,
  intakeConversation,
  INTAKE_ID,
  PINOMAD_INBOX,
  RUNNING_TASK_ID,
  withInbox,
} from "../../test/story-fixtures.tsx";
import { ConversationTranscript } from "./conversation-transcript.tsx";
import { InboxEventCard } from "./inbox-cards.tsx";

/** A transcript inside the Inbox it belongs to, as the main column renders it. */
function InboxTranscript({
  conversation,
  conversationId,
  onOpenTask,
}: {
  conversation: ConversationView;
  conversationId: ConversationId;
  onOpenTask: () => void;
}) {
  const view = withInbox();
  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <InboxTranscriptProvider inbox={view.inbox} organized={view.organized} conversationId={conversationId} onOpenTask={onOpenTask}>
        <ConversationTranscript
          conversation={conversation}
          toolPresentations={{}}
          connected
          canFork={false}
          openInPanel={() => {}}
          onOpenFork={() => {}}
          onFork={() => {}}
        />
      </InboxTranscriptProvider>
    </div>
  );
}

const meta = {
  title: "Widgets/Chat/InboxCards",
  component: InboxTranscript,
  args: { conversation: intakeConversation(), conversationId: INTAKE_ID, onOpenTask: fn() },
} satisfies Meta<typeof InboxTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The intake: each `inbox_submit` call becomes a card for its task, with where that task stands now (ADR-0051 §6). */
export const IntakeTaskCards: Story = {};

/** A task's conversation opens with the event that started it, not the worker's preface. */
export const TaskEvents: Story = {
  args: { conversation: inboxTaskConversation(), conversationId: RUNNING_TASK_ID },
};

/** The card alone: two events of one task, with the time the worker handed them over. */
export const EventCard: Story = {
  render: () => <InboxEventCard events={PINOMAD_INBOX.tasks.find((task) => task.events.length > 1)!.events} startedAt={Date.now()} />,
};
