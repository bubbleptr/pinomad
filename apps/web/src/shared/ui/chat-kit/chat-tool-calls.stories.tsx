import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatToolCalls } from "./chat-tool-calls";

const meta = {
  title: "Shared/ChatKit/ChatToolCalls",
  component: ChatToolCalls,
  args: {
    calls: [{ name: "read", target: "src/parser.ts", duration: "120ms" }],
  },
} satisfies Meta<typeof ChatToolCalls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const WithDetail: Story = {
  args: {
    calls: [
      {
        name: "bash",
        target: "bun run test",
        duration: "4.2s",
        resultDetail: <pre className="m-0 font-mono text-xs">✓ 141 tests passed</pre>,
      },
    ],
  },
};

export const Group: Story = {
  args: {
    calls: [
      { name: "read", target: "src/parser.ts", duration: "120ms" },
      { name: "edit", target: "src/parser.ts", additions: 4, deletions: 1, duration: "80ms" },
      { name: "bash", target: "bun run test", status: "error", errorMessage: "1 test failed" },
      { name: "bash", target: "bun run test", status: "running" },
    ],
  },
};

export const GroupExpanded: Story = {
  args: { ...Group.args, defaultIsExpanded: true },
};
