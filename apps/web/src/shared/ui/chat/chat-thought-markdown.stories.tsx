import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatThoughtMarkdown } from "./chat-thought-markdown.tsx";

const meta = {
  title: "Shared/Chat/ChatThoughtMarkdown",
  component: ChatThoughtMarkdown,
  args: {
    text: "The **tokenizer** drops the trailing *newline*, so `parseLine` sees an empty token at EOF.",
  },
} satisfies Meta<typeof ChatThoughtMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inline: Story = {};

// Mid-stream the closing ** has not arrived yet; the marker stays hidden.
export const UnclosedWhileStreaming: Story = {
  args: { text: "Checking whether the **lock file" },
};

export const UnwrappedHeadingLines: Story = {
  args: {
    text: "**Inspecting the parser**\nThe fix belongs in `tokenize`, not in the caller.",
    unwrapLines: true,
    style: { whiteSpace: "pre-wrap" },
  },
};
