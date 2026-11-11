import type { Meta, StoryObj } from "@storybook/react-vite";
import { Code } from "./code.tsx";
import { CodeBlock } from "./code-block.tsx";

const meta = {
  title: "Shared/CodeBlock",
  component: CodeBlock,
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
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeScript: Story = {};

// The join command: no language (shell colors would split the address), wrapped, full width.
export const Command: Story = {
  args: {
    language: undefined,
    code: "curl -fsSL https://pinomad.si/install.sh | sh -s -- join https://pinomad.example.com/j/3f9c2a7e41b8",
    isWrapped: true,
    width: "100%",
  },
};

// From 10 lines the header collapses the block.
export const Collapsible: Story = {
  args: {
    language: "json",
    isCollapsible: true,
    code: JSON.stringify({ name: "pinomad", private: true, workspaces: ["apps/*", "packages/*"], scripts: { test: "vitest run" } }, null, 2),
  },
};

export const InlineCode: Story = {
  render: () => (
    <p className="text-sm">
      Run <Code>bun run typecheck</Code> before opening the PR.
    </p>
  ),
};
