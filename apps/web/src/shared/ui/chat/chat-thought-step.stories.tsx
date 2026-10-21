import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatThoughtStep } from "./chat-thought-step.tsx";

const meta = {
  title: "Shared/Chat/ChatThoughtStep",
  component: ChatThoughtStep,
  args: {
    step: {
      kind: "thinking",
      id: "t1",
      text: "**Plan the fix**\nThe tokenizer drops the trailing newline, so `parseLine` sees an empty token. Patch `tokenize` and add a regression test.",
      live: false,
      durationMs: 2300,
    },
  },
} satisfies Meta<typeof ChatThoughtStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Settled: Story = {};

export const Live: Story = {
  args: { step: { kind: "thinking", id: "t1", text: "The tokenizer drops", live: true } },
};

// Sub-second thinking reads as "briefly" rather than rounding up.
export const Brief: Story = {
  args: { step: { kind: "thinking", id: "t1", text: "Read the file first.", live: false, durationMs: 400 } },
};

// The provider withheld the body: a plain row with nothing to open.
export const NoBody: Story = {
  args: { step: { kind: "thinking", id: "t1", text: "", live: false, durationMs: 5000 } },
};
