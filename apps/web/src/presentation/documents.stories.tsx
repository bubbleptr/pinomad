import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { DocumentView } from "./documents.tsx";

const meta = {
  title: "Presentation/DocumentView",
  component: DocumentView,
  args: {
    doc: {
      kind: "pinomad.todo",
      presentation: "pinomad.todo",
      value: {
        items: [
          { text: "Read the failing test", status: "completed" },
          { text: "Patch the parser", status: "in_progress" },
          { text: "Run the suite", status: "pending" },
        ],
      },
    },
    // The view renders from `doc` alone; the connection is part of the shared document-renderer signature.
    remote: {} as RemoteDurable,
    connected: true,
  },
} satisfies Meta<typeof DocumentView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Todo: Story = {};

export const Questions: Story = {
  args: {
    doc: {
      kind: "question.requests",
      presentation: "pinomad.question",
      value: {
        requests: [
          {
            id: "req-1",
            askedAt: 0,
            questions: [
              {
                header: "Auth",
                question: "Which auth should the upload API use?",
                options: [{ label: "Bearer tokens" }, { label: "Session cookies" }],
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
            resolution: {
              outcome: "answered",
              at: 0,
              answers: [
                { selected: ["Bearer tokens"] },
                { selected: ["Unit"], other: "contract tests against the host" },
                { selected: [] },
              ],
            },
          },
          {
            id: "req-2",
            askedAt: 0,
            questions: [{ header: "Naming", question: "Call it uploads or attachments?", options: [{ label: "uploads" }, { label: "attachments" }] }],
            resolution: { outcome: "dismissed", at: 0 },
          },
          {
            id: "req-3",
            askedAt: 0,
            questions: [{ header: "Limits", question: "Cap uploads at 5 MB?", options: [{ label: "Yes" }, { label: "No" }] }],
          },
        ],
      },
    },
  },
};

/** An unknown or malformed document still shows its top-level keys. */
export const Fallback: Story = {
  args: {
    doc: {
      kind: "acme.build-status",
      value: {
        pipeline: "release",
        passed: 412,
        failed: 3,
        flaky: ["upload retries after a relay handover", "pairing expiry at midnight UTC"],
        lastRun: { at: "2026-10-21T18:04:00Z", durationSeconds: 1832, runner: "omarchy", artifacts: ["pinomad-0.2.0.tgz", "Pinomad.dmg"] },
      },
    },
  },
};
