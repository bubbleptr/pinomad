import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { GitBranch } from "@/shared/ui/icons.tsx";
import { ChatMarkdown } from "./chat-markdown.tsx";
import { ChatMessage, ChatMessageActions } from "./chat-message.tsx";

const meta = {
  title: "Shared/Chat/ChatMessage",
  component: ChatMessage.Assistant,
} satisfies Meta<typeof ChatMessage.Assistant>;

export default meta;
type Story = StoryObj<typeof meta>;

export const User: Story = {
  render: () => (
    <ChatMessage.User>
      <ChatMessage.Bubble>
        <ChatMessage.Content>Why does the parser test fail on Windows line endings?</ChatMessage.Content>
      </ChatMessage.Bubble>
      <ChatMessageActions>
        <ChatMessageActions.Copy aria-label="Copy" tooltip="Copy" onPress={fn()} />
      </ChatMessageActions>
    </ChatMessage.User>
  ),
};

export const Assistant: Story = {
  render: (args) => (
    <ChatMessage.Assistant {...args}>
      <ChatMessage.Body>
        <ChatMessage.Content>
          <ChatMarkdown>
            {"The tokenizer splits on `\\n` only, so a `\\r\\n` file leaves a stray `\\r` on every token.\n\nNormalize line endings in `tokenize` before splitting."}
          </ChatMarkdown>
        </ChatMessage.Content>
        <ChatMessageActions className="chat-message__actions--persist">
          <ChatMessageActions.Copy aria-label="Copy" tooltip="Copy" onPress={fn()} />
          <ChatMessageActions.ThumbsUp aria-label="Good response" tooltip="Good response" onPress={fn()} />
          <ChatMessageActions.ThumbsDown aria-label="Bad response" tooltip="Bad response" onPress={fn()} />
          <ChatMessage.Action aria-label="Fork from message" tooltip="Fork from message" onPress={fn()}>
            <GitBranch aria-hidden="true" size={16} />
          </ChatMessage.Action>
        </ChatMessageActions>
      </ChatMessage.Body>
    </ChatMessage.Assistant>
  ),
};

export const Exchange: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <ChatMessage.User>
        <ChatMessage.Bubble>
          <ChatMessage.Content>Run the unit tests.</ChatMessage.Content>
        </ChatMessage.Bubble>
      </ChatMessage.User>
      <ChatMessage.Assistant>
        <ChatMessage.Body>
          <ChatMessage.Content>
            <ChatMarkdown>{"All **214** tests pass. Two were skipped because Playwright's Chromium is not installed."}</ChatMarkdown>
          </ChatMessage.Content>
        </ChatMessage.Body>
      </ChatMessage.Assistant>
    </div>
  ),
};
