import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FileAttachmentChip } from "../attachment/file-attachments.tsx";
import { attachmentRow } from "./attachments.tsx";
import { moss, sky, sunset } from "./image-fixtures.ts";

// `attachmentRow` builds the prompt input's attachments node rather than being
// a component, so the meta is typed by its argument.
const meta = {
  title: "Entities/Image/AttachmentRow",
  args: { images: [sky, sunset], pending: false, onRemove: fn() },
  render: (args) => <>{attachmentRow(args)}</>,
} satisfies Meta<Parameters<typeof attachmentRow>[0]>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Staged: Story = {};

export const Preparing: Story = {
  args: { images: [sky, sunset, moss], pending: true },
};

export const PreparingFirst: Story = {
  args: { images: [], pending: true },
};

export const WithFiles: Story = {
  args: {
    images: [sky],
    files: (
      <>
        <FileAttachmentChip
          entry={{ key: "a", name: "deploy.log", size: 12_345, status: "done", attachmentId: "A".repeat(22), received: 12_345 }}
          onRemove={fn()}
        />
        <FileAttachmentChip
          entry={{ key: "b", name: "parser.patch", size: 2_048, status: "uploading", received: 1_024 }}
          onRemove={fn()}
        />
      </>
    ),
  },
};
