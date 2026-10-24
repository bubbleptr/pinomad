import type { Meta, StoryObj } from "@storybook/react-vite";
import { MessageAttachments } from "./file-attachments.tsx";

const meta = {
  title: "Entities/Attachment/MessageAttachments",
  component: MessageAttachments,
  args: {
    attachments: [
      { id: "A".repeat(22), name: "parser.log", size: 12_345 },
      { id: "B".repeat(22), name: "screenshot-notes.md", size: 2_048 },
    ],
  },
} satisfies Meta<typeof MessageAttachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Several: Story = {};

export const One: Story = {
  args: { attachments: [{ id: "C".repeat(22), name: "empty.txt", size: 0 }] },
};
