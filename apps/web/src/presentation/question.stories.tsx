import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { QuestionRequest } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { QuestionCard } from "./question.tsx";

// The card only reaches the connection to send its answers.
const remote = { controller: { answer: fn(() => Promise.resolve()) } } as unknown as RemoteDurable;

const request: QuestionRequest = {
  id: "req-1",
  askedAt: 0,
  questions: [
    {
      header: "Auth",
      question: "Which auth should the upload API use?",
      options: [
        { label: "Bearer tokens", description: "Short-lived token from the refresh flow." },
        { label: "Session cookies" },
      ],
    },
    {
      header: "Tests",
      multiSelect: true,
      question: "Which test layers should cover it?",
      options: [{ label: "Unit" }, { label: "End-to-end" }],
    },
    {
      header: "Rollout",
      question: "Ship it behind a flag?",
      options: [{ label: "Flag, default off" }, { label: "Ship directly" }],
    },
  ],
};

const meta = {
  title: "Presentation/QuestionCard",
  component: QuestionCard,
  args: { kind: "question.requests", request, remote, connected: true },
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeveralQuestions: Story = {};

export const SingleQuestion: Story = {
  args: {
    request: {
      id: "req-2",
      askedAt: 0,
      questions: [
        {
          header: "Migration",
          question: "The users table has 2.4M rows. How should the new column be backfilled?",
          options: [
            { label: "Batched job", description: "10k rows per batch, resumable, runs after deploy." },
            { label: "In the migration", description: "One UPDATE inside the schema change; locks the table." },
            { label: "Lazily on read", description: "Fill each row the first time it is loaded." },
            { label: "Leave it null" },
          ],
        },
      ],
    },
  },
};

export const Disconnected: Story = {
  args: { connected: false },
};
