import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FileAttachmentChip } from "../attachment/file-attachments.tsx";
import { attachmentDrawer } from "./attachments.tsx";
import { moss, sky, sunset } from "./image-fixtures.ts";

// `attachmentDrawer` builds the prompt input's drawer node rather than being
// a component, so the meta is typed by its argument.
const meta = {
  title: "Entities/Image/AttachmentDrawer",
  args: { images: [sky, sunset], pending: false, onRemove: fn() },
  render: (args) => <>{attachmentDrawer(args)}</>,
} satisfies Meta<Parameters<typeof attachmentDrawer>[0]>;

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
