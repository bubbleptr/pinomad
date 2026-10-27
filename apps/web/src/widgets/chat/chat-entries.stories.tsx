import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ChatEntry, ConversationToolItem, CotStep, CotView } from "@pinomad/client/cot-view.ts";
import type { ToolItem } from "@pinomad/client/tool-item.ts";
import type { TodoState } from "@pinomad/protocol/presentation.ts";
import { ChatEntryView } from "./chat-entries.tsx";

type RunEntry = Extract<ChatEntry, { kind: "run" }>;

const now = Date.now();

function bash(id: string, command: string, state: ToolItem["state"] = "output-available"): ToolItem {
  return { toolName: "bash", toolCallId: id, argsText: JSON.stringify({ command }), state };
}

function run(cot: Partial<CotView> & { steps: CotStep[] }, overrides: Partial<RunEntry> = {}): RunEntry {
  return { kind: "run", id: "run-1", interrupted: false, cot: { phase: "settled", ...cot }, ...overrides };
}

const edit: ConversationToolItem = {
  toolName: "edit",
  toolCallId: "c4",
  argsText: JSON.stringify({ path: "src/parser.ts" }),
  state: "output-available",
  diffStat: { additions: 2, deletions: 1 },
  pinomad: {
    kind: "diff",
    patch: [
      "--- a/src/parser.ts",
      "+++ b/src/parser.ts",
      "@@ -10,4 +10,5 @@ export function parseList(tokens: Token[]) {",
      "   while (peek(tokens)) {",
      "-    items.push(parseItem(tokens));",
      "+    if (peek(tokens)?.kind === \"comma\") next(tokens);",
      "+    else items.push(parseItem(tokens));",
      "   }",
      "   return items;",
    ].join("\n"),
  },
};

const delegated: ConversationToolItem = {
  toolName: "subagent",
  toolCallId: "c5",
  argsText: JSON.stringify({ description: "Write regression tests" }),
  state: "output-available",
  pinomad: {
    kind: "subagent",
    conversationId: 7 as ConversationId,
    model: "anthropic/claude-opus-5-5",
    startedAt: Date.now() - 40_000,
    endedAt: Date.now() - 4_000,
  },
};

const narrated: CotStep[] = [
  { kind: "thinking", id: "a-thinking-0", text: "The trailing comma case is probably in parseList.", live: false, durationMs: 2_300 },
  { kind: "tools", id: "a-tools-1", tools: [bash("c1", "ls src"), bash("c2", "cat src/parser.ts")], live: false },
  { kind: "interim", id: "b-text-0", text: "Found the parser bug: a trailing comma is parsed as an empty item." },
  { kind: "tools", id: "b-tools-1", tools: [edit, bash("c3", "bun test")], live: false },
];

const answer = {
  text: "Fixed. `parseList` now skips a trailing comma instead of parsing it as an empty item, and `bun test` passes.",
  streaming: false,
};

const plan: TodoState = {
  items: [
    { text: "Find the bug", status: "completed" },
    { text: "Fix it", status: "in_progress" },
    { text: "Add a regression test", status: "pending" },
  ],
};

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAH0lEQVR42mNwqDgRteDOs1UBJ6KiGOAsoCgDnAUUBQCKFBQXyXLRywAAAABJRU5ErkJggg==";

const meta = {
  title: "Widgets/Chat/ChatEntryView",
  component: ChatEntryView,
  args: {
    entry: run({ elapsedMs: 16_400, steps: narrated, answer }, { forkEntryId: "entry-9", endedAt: now - 5_000 }),
    connected: true,
    openInPanel: fn(),
    onFork: fn(),
    onRetrySubmission: fn(),
    onEditSubmission: fn(),
  },
} satisfies Meta<typeof ChatEntryView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SettledRun: Story = {};

export const UserMessage: Story = {
  args: {
    entry: {
      kind: "user",
      id: "user-1",
      text: "$review the parser change — trailing commas still break lists",
      images: [{ data: PNG, mimeType: "image/png" }],
      skills: ["review"],
      attachments: [{ id: "A".repeat(22), name: "parser.log", size: 12_345 }],
      timestamp: now - 95_000,
    },
  },
};

const localEntry = (
  status: "sending" | "unknown" | "failed",
  overrides: Partial<Extract<ChatEntry, { kind: "user" }>> = {},
): Extract<ChatEntry, { kind: "user" }> => ({
  kind: "user",
  id: "local:local-1",
  text: "Check the parser regression before merging",
  images: [],
  attachments: [],
  skills: ["review"],
  status,
  local: { requestId: "local-1" },
  ...overrides,
});

export const SubmissionSending: Story = {
  args: { entry: localEntry("sending") },
};

export const SubmissionNotConfirmed: Story = {
  args: { entry: localEntry("unknown") },
};

export const SubmissionFailed: Story = {
  args: {
    entry: localEntry("failed", {
      local: { requestId: "local-1", error: "The host refused this message: no conversation selected." },
    }),
  },
};

export const SubmissionDelivered: Story = {
  args: {
    entry: {
      kind: "user",
      id: "user-42",
      text: "Check the parser regression before merging",
      images: [],
      attachments: [],
      skills: ["review"],
      timestamp: now - 30_000,
      status: "delivered",
    },
  },
};

export const LiveRun: Story = {
  args: {
    entry: run({
      phase: "acting",
      anchorMs: Date.now() - 5_000,
      steps: [
        narrated[1]!,
        { kind: "interim", id: "live-text-0", text: "Running the suite now." },
        { kind: "tools", id: "live-tools-1", tools: [bash("c3", "bun test", "input-available")], live: true, activeToolCallId: "c3" },
      ],
    }),
  },
};

export const StreamingAnswer: Story = {
  args: {
    entry: run({
      phase: "answering",
      anchorMs: Date.now() - 12_000,
      steps: narrated,
      answer: { text: "Fixed. `parseList` now skips a trailing comma", streaming: true },
    }),
  },
};

export const FailedRun: Story = {
  args: {
    entry: run(
      { elapsedMs: 1_400, outcome: "failed", steps: [narrated[1]!] },
      { failure: "Provider returned 529: overloaded", endedAt: now - 60_000 },
    ),
    onRetry: fn(async () => {}),
  },
};

export const WithTodoAndSubagent: Story = {
  args: {
    entry: run(
      {
        elapsedMs: 48_000,
        todoWrittenAtMs: Date.now(),
        steps: [
          ...narrated,
          {
            kind: "tools",
            id: "c-tools-0",
            tools: [delegated],
            live: false,
          },
        ],
        answer,
      },
      { endedAt: now - 30_000 },
    ),
    todo: { state: plan, updatedAtMs: Date.now() },
  },
};

export const Forked: Story = {
  args: { forksAt: () => [3 as ConversationId] },
};

export const Dividers: Story = {
  render: (args) => (
    <>
      <ChatEntryView {...args} entry={{ kind: "compaction", id: "compaction-1" }} />
      <ChatEntryView {...args} entry={{ kind: "reset", id: "reset-1" }} />
    </>
  ),
};
