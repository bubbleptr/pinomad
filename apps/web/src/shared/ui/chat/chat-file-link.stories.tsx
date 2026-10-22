import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatFileLink } from "./chat-file-link.tsx";

// The chip styles are scoped to chat Markdown, where this renderer lives.
const meta = {
  title: "Shared/Chat/ChatFileLink",
  component: ChatFileLink,
  args: { href: "src/parser.ts:12", children: "src/parser.ts:12" },
  decorators: [
    (Story) => (
      <div className="chat-markdown">
        <p>
          The fix is in <Story /> next to the tokenizer.
        </p>
      </div>
    ),
  ],
} satisfies Meta<typeof ChatFileLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FileChipWithLine: Story = {};

export const FileChip: Story = {
  args: { href: "apps/web/src/shared/ui/chat/chat-markdown.tsx", children: "apps/web/src/shared/ui/chat/chat-markdown.tsx" },
};

export const LineAnchor: Story = {
  args: { href: "AGENTS.md#L42", children: "AGENTS.md#L42" },
};

// A prose label keeps its text; the chip only replaces a repeated target.
export const CustomLabel: Story = {
  args: { href: "src/parser.ts:12", children: "the tokenizer's EOF branch" },
};

export const ExternalUrl: Story = {
  args: { href: "https://github.com/bubbleptr/pinomad/issues/143", children: "issue #143" },
};
