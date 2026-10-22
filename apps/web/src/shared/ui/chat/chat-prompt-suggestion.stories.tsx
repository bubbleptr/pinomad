import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FileDiff, ListTree, SquareTerminal, Wrench } from "@/shared/ui/icons.tsx";
import { ChatPromptSuggestion } from "./chat-prompt-suggestion.tsx";

const meta = {
  title: "Shared/Chat/ChatPromptSuggestion",
  component: ChatPromptSuggestion,
} satisfies Meta<typeof ChatPromptSuggestion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pills: Story = {
  render: (args) => (
    <ChatPromptSuggestion {...args}>
      <ChatPromptSuggestion.Items>
        <ChatPromptSuggestion.Item onPress={fn()}>Summarize the last run</ChatPromptSuggestion.Item>
        <ChatPromptSuggestion.Item onPress={fn()}>Write tests for chat-file-link</ChatPromptSuggestion.Item>
        <ChatPromptSuggestion.Item onPress={fn()}>Explain ADR-0026</ChatPromptSuggestion.Item>
      </ChatPromptSuggestion.Items>
    </ChatPromptSuggestion>
  ),
};

const suggested = [
  { Icon: ListTree, label: "Explain this repo's architecture" },
  { Icon: Wrench, label: "Fix the failing test" },
  { Icon: SquareTerminal, label: "Add a CLI flag with docs" },
  { Icon: FileDiff, label: "Review my uncommitted changes" },
];

// The draft home's grid: leading icon, no end arrow.
export const DraftHomeGrid: Story = {
  render: (args) => (
    <ChatPromptSuggestion {...args} className="w-full max-w-[35rem]">
      <ChatPromptSuggestion.Items className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {suggested.map(({ Icon, label }) => (
          <ChatPromptSuggestion.Item
            key={label}
            className="items-center justify-start"
            showEndIcon={false}
            onPress={fn()}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </span>
          </ChatPromptSuggestion.Item>
        ))}
      </ChatPromptSuggestion.Items>
    </ChatPromptSuggestion>
  ),
};
