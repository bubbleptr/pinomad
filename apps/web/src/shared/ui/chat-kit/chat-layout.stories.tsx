import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { fn } from "storybook/test";
import { ChatComposer } from "./chat-composer";
import { ChatLayout } from "./chat-layout";
import { ChatMessage } from "./chat-message";
import { ChatMessageBubble } from "./chat-message-bubble";
import { ChatMessageList } from "./chat-message-list";

function Messages({ count }: { count: number }) {
  return (
    <ChatMessageList>
      {Array.from({ length: count }, (_, index) => (
        <ChatMessage key={index} sender={index % 2 === 0 ? "user" : "assistant"}>
          <ChatMessageBubble variant={index % 2 === 0 ? "filled" : "ghost"}>
            {index % 2 === 0
              ? `Question ${index / 2 + 1}: what changed in the parser?`
              : "The tokenizer now keeps line breaks, so the error positions line up with the source again."}
          </ChatMessageBubble>
        </ChatMessage>
      ))}
    </ChatMessageList>
  );
}

const meta = {
  title: "Shared/ChatKit/ChatLayout",
  component: ChatLayout,
  parameters: { canvasWidth: "full" },
  args: { children: null, composer: null },
  // The layout scrolls itself, so it needs a bounded height.
  decorators: [
    (Story) => (
      <div className="flex h-[480px] flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Long enough to scroll: scroll up to reveal the scroll-to-bottom button. */
export const Scrolling: Story = {
  render: () => (
    <ChatLayout composer={<ChatComposer onSubmit={fn()} placeholder="Ask the agent…" />}>
      <Messages count={16} />
    </ChatLayout>
  ),
};

/**
 * A message lands every two seconds. At the bottom the layout follows it;
 * scrolled up, the button turns into "New messages".
 */
export const Streaming: Story = {
  render: function Render() {
    const [count, setCount] = useState(8);
    useEffect(() => {
      const timer = window.setInterval(() => setCount((n) => n + 1), 2000);
      return () => window.clearInterval(timer);
    }, []);
    return (
      <ChatLayout composer={<ChatComposer onSubmit={fn()} placeholder="Ask the agent…" />}>
        <Messages count={count} />
      </ChatLayout>
    );
  },
};

export const Empty: Story = {
  render: () => (
    <ChatLayout
      composer={<ChatComposer onSubmit={fn()} placeholder="Ask the agent…" />}
      emptyState={<p className="text-sm text-muted-foreground">No messages yet</p>}
    >
      {null}
    </ChatLayout>
  ),
};
