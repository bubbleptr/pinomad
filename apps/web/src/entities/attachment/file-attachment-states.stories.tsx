// Visual reference for issue #321: the three upload states in the composer
// drawer and a sent bubble's file chips, in whichever theme the toolbar picks.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { attachmentDrawer } from "../image/attachments.tsx";
import { ChatMessage } from "@/shared/ui/chat/chat-message";
import { ChatPromptInput } from "@/shared/ui/chat/chat-prompt-input";
import { FileAttachmentChip, MessageAttachments } from "./file-attachments.tsx";
import type { FileAttachmentEntry } from "./use-file-attachments.ts";

const entries: FileAttachmentEntry[] = [
  {
    key: "done",
    name: "deploy.log",
    size: 12_345,
    status: "done",
    attachmentId: "A".repeat(22),
    received: 12_345,
  },
  {
    key: "uploading",
    name: "bundle.tar.gz",
    size: 8 * 1024 * 1024,
    status: "uploading",
    attachmentId: "B".repeat(22),
    received: 3 * 1024 * 1024,
  },
  {
    key: "failed",
    name: "trace.json",
    size: 900_000,
    status: "failed",
    received: 128_000,
    error: "host offline",
  },
];

const meta = {
  title: "Entities/Attachment/ComposerAndBubble",
  parameters: { canvasWidth: "full" },
  render: () => (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 p-6">
      <ChatMessage.User>
        <div className="flex flex-col items-end gap-1">
          <MessageAttachments
            attachments={[
              { id: "A".repeat(22), name: "deploy.log", size: 12_345 },
              { id: "B".repeat(22), name: "bundle.tar.gz", size: 8 * 1024 * 1024 },
            ]}
          />
          <ChatMessage.Bubble>
            <ChatMessage.Content>Here are the release logs.</ChatMessage.Content>
          </ChatMessage.Bubble>
        </div>
      </ChatMessage.User>
      <ChatPromptInput
        value=""
        status="ready"
        hasAttachments
        attachments={attachmentDrawer({
          images: [],
          pending: false,
          onRemove: () => {},
          files: (
            <>
              {entries.map((entry) => (
                <FileAttachmentChip key={entry.key} entry={entry} onRetry={() => {}} onRemove={() => {}} />
              ))}
            </>
          ),
        })}
        onFiles={() => {}}
      />
    </div>
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const UploadStates: Story = {};
