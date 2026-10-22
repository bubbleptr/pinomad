import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ChatToolItem } from "./chat-tool.tsx";
import { ChatToolStep } from "./chat-tool-step.tsx";

const read: ChatToolItem = {
  toolCallId: "c1",
  toolName: "read",
  state: "output-available",
  argsText: '{"path":"AGENTS.md"}',
  output: "Agent instructions loaded.",
  durationMs: 45,
};

const meta = {
  title: "Shared/Chat/ChatToolStep",
  component: ChatToolStep,
  args: { step: { kind: "tools", id: "s1", live: false, tools: [read] } },
} satisfies Meta<typeof ChatToolStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleCall: Story = {};

// One click goes straight to the args and output; no second header.
export const SingleCallExpanded: Story = {
  play: async ({ canvasElement }) => {
    const row = within(canvasElement).getByRole("button", { name: /Read AGENTS.md/ });
    await userEvent.click(row);
    await expect(row).toHaveAttribute("aria-expanded", "true");
  },
};

export const Burst: Story = {
  args: {
    step: {
      kind: "tools",
      id: "s1",
      live: false,
      tools: [
        { toolCallId: "c1", toolName: "bash", state: "output-available", argsText: '{"command":"bun run test"}', output: "214 passed", durationMs: 8200 },
        { toolCallId: "c2", toolName: "edit", state: "output-available", argsText: '{"path":"src/tokenize.ts"}', diffStat: { additions: 12, deletions: 3 }, durationMs: 40 },
        { toolCallId: "c3", toolName: "edit", state: "output-available", argsText: '{"path":"src/tokenize.test.ts"}', diffStat: { additions: 24, deletions: 0 }, durationMs: 35 },
        { toolCallId: "c4", toolName: "bash", state: "output-error", argsText: '{"command":"cargo test"}', output: "exit 101", durationMs: 4100 },
      ],
    },
  },
};

export const BurstExpanded: Story = {
  args: Burst.args,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /Ran 2 commands/ }));
  },
};

export const Live: Story = {
  args: {
    step: {
      kind: "tools",
      id: "s1",
      live: true,
      activeToolCallId: "c2",
      tools: [
        { toolCallId: "c1", toolName: "read", state: "output-available", argsText: '{"path":"src/parser.ts"}' },
        { toolCallId: "c2", toolName: "bash", state: "input-available", argsText: '{"command":"bun run test"}' },
      ],
    },
  },
};

// The live label names the deepest running Nested Tool Execution.
export const LiveNested: Story = {
  args: {
    step: {
      kind: "tools",
      id: "s1",
      live: true,
      activeToolCallId: "c1",
      tools: [
        {
          toolCallId: "c1",
          toolName: "codemode",
          state: "input-available",
          children: [
            {
              toolCallId: "c1/1",
              toolName: "mcp__probe__echo",
              state: "input-available",
              children: [{ toolCallId: "c1/1/1", toolName: "bash", state: "input-available" }],
            },
          ],
        },
      ],
    },
  },
};

export const SettledNested: Story = {
  args: {
    step: {
      kind: "tools",
      id: "s1",
      live: false,
      tools: [
        {
          toolCallId: "c1",
          toolName: "codemode",
          state: "output-available",
          argsText: 'return await tools.mcp__probe__echo({ text: "hi" })',
          output: "ECHO:hi",
          children: [
            { toolCallId: "c1/1", toolName: "mcp__probe__echo", state: "output-available", argsText: '{"text":"hi"}', output: "ECHO:hi" },
            { toolCallId: "c1/2", toolName: "bash", state: "output-error", argsText: '{"command":"false"}', output: "exit 1" },
          ],
        },
      ],
    },
  },
};
