import type { QueueItem } from "@pinomad/client/chat.ts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { QueuedList } from "./queued-list.tsx";

const meta = {
  title: "Widgets/Composer/QueuedList",
  component: QueuedList,
  args: {
    items: [
      { id: 1, mode: "steer", text: "Skip the e2e suite, just run unit tests", imageCount: 0, attachmentCount: 0, status: "sent" as const },
      { id: 2, mode: "followUp", text: "Then open a PR against main", imageCount: 0, attachmentCount: 0, status: "sent" as const },
    ],
    canAct: true,
    canReorder: true,
    busy: true,
    editDisabled: false,
    narrow: false,
    pendingIds: new Set(),
    pendingRequestIds: new Set(),
    onRetry: fn(),
    onSteer: fn(),
    onEdit: fn(),
    onWithdraw: fn(),
    onReorder: fn(),
  },
} satisfies Meta<typeof QueuedList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EveryMode: Story = {
  args: {
    items: [
      { id: 1, mode: "steer", text: "Use the existing date helper instead", imageCount: 0, attachmentCount: 0, status: "sent" as const },
      { id: 2, mode: "followUp", text: "Does this match the mockup?", imageCount: 1, attachmentCount: 0, status: "sent" as const },
      { id: 3, mode: "followUp", text: "", imageCount: 2, attachmentCount: 1, status: "sent" as const },
      { id: 4, mode: "write", text: "<custom>", imageCount: 0, attachmentCount: 0, status: "sent" as const },
    ],
  },
};

export const SubmissionQueued: Story = {
  args: {
    items: [
      { id: 7, mode: "followUp", text: "Then run the release notes pass", imageCount: 0, attachmentCount: 0, status: "sent" },
      {
        requestId: "local-1",
        mode: "followUp",
        text: "Check the parser regression before merging",
        imageCount: 0,
        attachmentCount: 0,
        status: "unknown",
        local: {},
      },
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

export const Narrow: Story = {
  args: { narrow: true },
  render: (args) => (
    <div style={{ maxWidth: 375 }}>
      <QueuedList {...args} />
    </div>
  ),
};

// A host older than 5.28 has no reorderQueued: no handles, everything else stays.
export const NoReorder: Story = {
  args: { canReorder: false },
};

export const LongMessage: Story = {
  args: {
    items: [
      {
        id: 1,
        mode: "followUp",
        text: "After the refactor lands, go through every call site of parseConfig in apps/host and apps/server, switch them to the new loader, and make sure the error messages still name the file and line that failed.",
        imageCount: 0, attachmentCount: 0, status: "sent" as const,
      },
    ],
  },
};

/** Drag a handle, or focus one and press ↑/↓: the order changes as a host would apply it. */
export const Interactive: Story = {
  render: function Render(args) {
    const [items, setItems] = useState<readonly QueueItem[]>([
      { id: 1, mode: "steer", text: "Use the existing date helper instead", imageCount: 0, attachmentCount: 0, status: "sent" },
      { id: 2, mode: "followUp", text: "Then run the release notes pass", imageCount: 0, attachmentCount: 0, status: "sent" },
      { id: 3, mode: "followUp", text: "Open a PR against main", imageCount: 0, attachmentCount: 0, status: "sent" },
      { id: 4, mode: "followUp", text: "Summarize what changed", imageCount: 0, attachmentCount: 0, status: "sent" },
    ]);
    return (
      <QueuedList
        {...args}
        items={items}
        onReorder={(moved, before) =>
          setItems((current) => {
            const rest = current.filter((item) => item.id !== moved.id);
            const at = before === undefined ? rest.length : rest.findIndex((item) => item.id === before);
            return [...rest.slice(0, at), moved, ...rest.slice(at)];
          })
        }
      />
    );
  },
};
