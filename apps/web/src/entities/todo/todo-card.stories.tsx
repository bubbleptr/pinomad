import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TodoItem } from "@pinomad/protocol/presentation.ts";
import { TodoCard } from "./todo-card.tsx";

const plan: TodoItem[] = [
  { text: "Read the failing test", status: "completed" },
  { text: "Find the root cause", status: "completed" },
  { text: "Patch the parser", status: "in_progress" },
  { text: "Run the suite", status: "pending" },
];

const done: TodoItem[] = plan.map((item) => ({ ...item, status: "completed" }));

const meta = {
  title: "Entities/Todo/TodoCard",
  component: TodoCard,
  args: { todo: { items: plan }, writtenThisRun: true, updatedAtMs: Date.now() },
} satisfies Meta<typeof TodoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {};

/** Left over from an earlier run: still unfinished, dated by its last write. */
export const Stale: Story = {
  args: { writtenThisRun: false, updatedAtMs: Date.now() - 3 * 60 * 60_000 },
};

export const AllDone: Story = {
  args: { todo: { items: done } },
};

export const LongItems: Story = {
  args: {
    todo: {
      items: [
        { text: "Trace why the reconnect loop drops the queued follow-up when the relay hands over mid-turn", status: "completed" },
        {
          text: "Move the pending-submit buffer from the composer into the session controller so a reconnect replays it in order, then cover the handover with an interop test",
          status: "in_progress",
        },
        { text: "Port the same fix to pinomad-core and regenerate the comparison vectors", status: "pending" },
        { text: "Check iOS against a real relay handover on device", status: "pending" },
        { text: "Write the changelog entry", status: "pending" },
      ],
    },
    updatedAtMs: undefined,
  },
};
