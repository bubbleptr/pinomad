import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatTool, ChatToolGroup, type ChatToolItem } from "./chat-tool.tsx";

const meta = {
  title: "Shared/Chat/ChatTool",
  component: ChatTool,
  args: {
    toolCallId: "call-1",
    toolName: "read",
    state: "output-available",
    argsText: '{"path":"AGENTS.md"}',
    output: "Agent instructions loaded.",
    durationMs: 45,
  },
} satisfies Meta<typeof ChatTool>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const Running: Story = {
  args: { toolName: "bash", state: "input-available", argsText: '{"command":"bun run test"}', output: undefined, durationMs: undefined },
};

// No args or output yet: the row is not expandable.
export const StreamingArgs: Story = {
  args: { toolName: "search", state: "input-streaming", argsText: undefined, output: undefined, durationMs: undefined },
};

export const Failed: Story = {
  args: { argsText: '{"path":"src/missing.ts"}', output: "ENOENT: file not found", state: "output-error" },
};

export const EditWithDiffStat: Story = {
  args: {
    toolName: "edit",
    argsText: '{"path":"src/main.ts"}',
    output: "edited src/main.ts",
    diffStat: { additions: 12, deletions: 3 },
    durationMs: 120,
  },
};

const groupTools: ChatToolItem[] = [
  {
    toolCallId: "call-1",
    toolName: "read",
    state: "output-available",
    argsText: '{"path":"AGENTS.md"}',
    output: "loaded",
    durationMs: 45,
  },
  {
    toolCallId: "call-2",
    toolName: "bash",
    state: "output-error",
    argsText: '{"command":"yarn test"}',
    output: "exit 1",
    durationMs: 3200,
  },
  {
    toolCallId: "call-3",
    toolName: "mcp__probe__echo",
    state: "output-available",
    argsText: '{"text":"hi"}',
    output: "ECHO:hi",
    durationMs: 8,
  },
];

export const Group: Story = {
  render: () => <ChatToolGroup tools={groupTools} />,
};
