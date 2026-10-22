import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { RenameConversationDialog } from "./rename-dialog.tsx";

const remote = { controller: { renameConversation: fn(async () => {}) } } as unknown as RemoteDurable;

const meta = {
  title: "Widgets/AppFrame/RenameConversationDialog",
  component: RenameConversationDialog,
  args: {
    summary: { id: 1 as ConversationId, kind: "conversation", title: "Fix the parser's trailing-comma bug" },
    remote,
    connected: true,
    onClose: fn(),
  },
} satisfies Meta<typeof RenameConversationDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disconnected: Story = { args: { connected: false } };

export const RenameFails: Story = {
  args: {
    remote: {
      controller: { renameConversation: fn(async () => Promise.reject(new Error("Conversation not found"))) },
    } as unknown as RemoteDurable,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Title"), " (v2)");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
  },
};
