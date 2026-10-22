import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CotStep } from "@pinomad/client/cot-view.ts";
import { ChatChainOfThought, ChatTraceRow } from "./chat-chain-of-thought.tsx";
import { ChatMarkdown } from "./chat-markdown.tsx";
import { ChatMessage } from "./chat-message.tsx";
import type { ChatToolItem } from "./chat-tool.tsx";

type TraceStep = Exclude<CotStep, { kind: "interim" }>;

const readParser: ChatToolItem = {
  toolCallId: "c1",
  toolName: "read",
  state: "output-available",
  argsText: '{"path":"src/parser.ts"}',
  output: "export function parse(source: string) { … }",
  durationMs: 40,
};
const runTests: ChatToolItem = {
  toolCallId: "c2",
  toolName: "bash",
  state: "output-error",
  argsText: '{"command":"bun run test"}',
  output: "3 failed, 211 passed",
  durationMs: 8200,
};
const editTokenizer: ChatToolItem = {
  toolCallId: "c3",
  toolName: "edit",
  state: "output-available",
  argsText: '{"path":"src/tokenize.ts"}',
  diffStat: { additions: 12, deletions: 3 },
  durationMs: 35,
};

const settledSteps: TraceStep[] = [
  { kind: "thinking", id: "t1", text: "The parser test fails only on CRLF input. Read the parser first.", live: false, durationMs: 2300 },
  { kind: "tools", id: "s1", live: false, tools: [readParser, runTests] },
  { kind: "thinking", id: "t2", text: "", live: false, durationMs: 400 },
  { kind: "tools", id: "s2", live: false, tools: [editTokenizer] },
];

// Trace rows sit in an assistant message body, which stretches to hold them.
const meta = {
  title: "Shared/Chat/ChatChainOfThought",
  component: ChatTraceRow,
  args: {
    steps: settledSteps,
    counted: [readParser, runTests, editTokenizer],
    tail: "16s",
  },
  decorators: [
    (Story) => (
      <ChatMessage.Assistant style={{ maxWidth: 720 }}>
        <ChatMessage.Body>
          <Story />
        </ChatMessage.Body>
      </ChatMessage.Assistant>
    ),
  ],
  render: (args) => (
    <ChatChainOfThought phase={args.live ? "acting" : "settled"}>
      <ChatTraceRow {...args} />
    </ChatChainOfThought>
  ),
} satisfies Meta<typeof ChatTraceRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Settled: Story = {};

export const FailedRun: Story = {
  args: { tail: "Failed after 16s" },
};

export const OnlyThought: Story = {
  args: {
    steps: [{ kind: "thinking", id: "t1", text: "Nothing to run; answer from the ADR.", live: false, durationMs: 1800 }],
    counted: [],
    tail: "2s",
  },
};

// No clock here: a running clock ticks every 100ms for as long as the story is open.
export const LiveRunningTool: Story = {
  args: {
    steps: [
      { kind: "tools", id: "s1", live: false, tools: [readParser] },
      {
        kind: "tools",
        id: "s2",
        live: true,
        activeToolCallId: "c2",
        tools: [{ toolCallId: "c2", toolName: "bash", state: "input-available", argsText: '{"command":"bun run test"}' }],
      },
    ],
    counted: [readParser],
    live: true,
    tail: undefined,
  },
};

// Before the first step lands the row is a plain line with nothing to open.
export const LiveBeforeFirstStep: Story = {
  args: { steps: [], counted: [], live: true, waiting: "Thinking…", tail: undefined },
};

// The transcript's shape: trace rows cut by Interim Output, in Turn order.
export const WithInterimOutput: Story = {
  render: () => (
    <>
      <ChatChainOfThought phase="settled">
        <ChatTraceRow steps={settledSteps.slice(0, 2)} counted={[readParser, runTests]} />
        <ChatMessage.Content data-slot="chat-interim-output">
          <ChatMarkdown>{"Found the parser bug: `tokenize` splits on `\\n` only. Patching it now."}</ChatMarkdown>
        </ChatMessage.Content>
        <ChatTraceRow steps={settledSteps.slice(2)} counted={[editTokenizer]} tail="16s" />
      </ChatChainOfThought>
      <ChatMessage.Content>
        <ChatMarkdown>{"Fixed. The tokenizer now normalizes `\\r\\n` before splitting, and the three CRLF tests pass."}</ChatMarkdown>
      </ChatMessage.Content>
    </>
  ),
};
