import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { FileAttachmentEntry } from "./use-file-attachments.ts";
import { FileAttachmentChip } from "./file-attachments.tsx";

const entry = (overrides: Partial<FileAttachmentEntry> = {}): FileAttachmentEntry => ({
  key: "file-1",
  name: "deploy.log",
  size: 12_345,
  status: "done",
  attachmentId: "A".repeat(22),
  received: 12_345,
  ...overrides,
});

const meta = {
  title: "Entities/Attachment/FileAttachmentChip",
  component: FileAttachmentChip,
  args: { entry: entry(), onRetry: fn(), onRemove: fn() },
} satisfies Meta<typeof FileAttachmentChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Done: Story = {};

export const Uploading: Story = {
  args: { entry: entry({ status: "uploading", received: 4_000 }) },
};

export const Failed: Story = {
  args: { entry: entry({ status: "failed", received: 4_000, error: "host offline" }) },
};

export const LongName: Story = {
  args: {
    entry: entry({
      name: "2026-10-24-a-very-long-build-log-from-the-release-workflow-with-a-suffix.txt",
    }),
  },
};
