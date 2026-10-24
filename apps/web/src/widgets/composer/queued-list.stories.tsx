import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { QueuedList } from "./queued-list.tsx";

const meta = {
  title: "Widgets/Composer/QueuedList",
  component: QueuedList,
  args: {
    items: [
      { id: 1, mode: "steer", text: "Skip the e2e suite, just run unit tests", imageCount: 0, attachmentCount: 0 },
      { id: 2, mode: "followUp", text: "Then open a PR against main", imageCount: 0, attachmentCount: 0 },
    ],
    canAct: true,
    busy: true,
    editDisabled: false,
    narrow: false,
    pendingIds: new Set(),
    onSteer: fn(),
    onEdit: fn(),
    onWithdraw: fn(),
  },
} satisfies Meta<typeof QueuedList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EveryMode: Story = {
  args: {
    items: [
      { id: 1, mode: "steer", text: "Use the existing date helper instead", imageCount: 0, attachmentCount: 0 },
      { id: 2, mode: "followUp", text: "Does this match the mockup?", imageCount: 1, attachmentCount: 0 },
      { id: 3, mode: "followUp", text: "", imageCount: 2, attachmentCount: 1 },
      { id: 4, mode: "write", text: "<custom>", imageCount: 0, attachmentCount: 0 },
    ],
  },
};

export const RequestInFlight: Story = {
  args: { pendingIds: new Set([2]) },
};

export const ComposerOccupied: Story = {
  args: { editDisabled: true, editTooltip: "Clear the composer to edit" },
};

// Disconnected, or a host older than the 5.14 queued-input calls: rows are read-only.
export const ReadOnly: Story = {
  args: { canAct: false },
};

export const LongMessage: Story = {
  args: {
    items: [
      {
        id: 1,
        mode: "followUp",
        text: "After the refactor lands, go through every call site of parseConfig in apps/host and apps/server, switch them to the new loader, and make sure the error messages still name the file and line that failed.",
        imageCount: 0, attachmentCount: 0,
      },
    ],
  },
};
