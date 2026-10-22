import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatCodeBlock } from "./chat-code-block.tsx";

const meta = {
  title: "Shared/Chat/ChatCodeBlock",
  component: ChatCodeBlock,
  args: {
    language: "ts",
    code: [
      'import { parseChatFileHref } from "./chat-file-link.tsx";',
      "",
      "export function lineOf(href: string) {",
      "  return parseChatFileHref(href)?.line ?? null;",
      "}",
    ].join("\n"),
  },
} satisfies Meta<typeof ChatCodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeScript: Story = {};

export const Shell: Story = {
  args: {
    language: "sh",
    code: "bun run typecheck && bun run test",
  },
};

// Unknown languages degrade to plain text.
export const PlainTextLog: Story = {
  args: {
    language: undefined,
    code: [
      "[host] listening on 127.0.0.1:7438",
      "[host] paired device mbp (protocol 1.9)",
      "[host] conversation c-91f2 started: model claude-sonnet",
      "[host] tool bash exited 1 after 3.2s",
    ].join("\n"),
  },
};
