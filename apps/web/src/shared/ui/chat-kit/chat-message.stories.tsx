import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatMessage } from "./chat-message";
import { ChatMessageBubble } from "./chat-message-bubble";
import { ChatMessageList } from "./chat-message-list";
import { ChatMessageMetadata } from "./chat-message-metadata";
import { ChatSystemMessage } from "./chat-system-message";

const meta = {
  title: "Shared/ChatKit/ChatMessage",
  component: ChatMessage,
  args: { sender: "user", children: null },
} satisfies Meta<typeof ChatMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  render: () => (
    <ChatMessageList>
      <ChatMessage sender="user">
        <ChatMessageBubble metadata={<ChatMessageMetadata timestamp="10:42" status="delivered" />}>
          Why does the parser test fail on Windows?
        </ChatMessageBubble>
      </ChatMessage>
      <ChatSystemMessage variant="divider">Earlier context summarized</ChatSystemMessage>
      <ChatMessage sender="assistant" name="Agent">
        <ChatMessageBubble variant="ghost">
          It splits on a hard-coded forward slash; paths on Windows use backslashes.
        </ChatMessageBubble>
      </ChatMessage>
      <ChatMessage sender="user">
        <ChatMessageBubble group="first">Fix it.</ChatMessageBubble>
        <ChatMessageBubble group="last">And add a regression test.</ChatMessageBubble>
        <ChatMessageMetadata timestamp="10:44" status="sending" />
      </ChatMessage>
      <ChatSystemMessage>New context</ChatSystemMessage>
    </ChatMessageList>
  ),
};

/** The status words, including a relabelled one (the app's unconfirmed "sending"). */
export const Statuses: Story = {
  render: () => (
    <ChatMessageList>
      {(["sending", "sent", "delivered", "read", "error"] as const).map((status) => (
        <ChatMessage key={status} sender="user">
          <ChatMessageBubble>{status}</ChatMessageBubble>
          <ChatMessageMetadata timestamp="10:42" status={status} />
        </ChatMessage>
      ))}
      <ChatMessage sender="user">
        <ChatMessageBubble>unknown</ChatMessageBubble>
        <ChatMessageMetadata timestamp="10:42" status="sending" statusLabels={{ sending: "Not confirmed" }} />
      </ChatMessage>
    </ChatMessageList>
  ),
};
