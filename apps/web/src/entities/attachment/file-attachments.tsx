// File attachments in the composer and in a sent bubble (issue #321), as
// Attachment cards: the same card the image thumbnails beside them use.
import type { UserAttachment } from "@pinomad/protocol/attachments.ts";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/shared/ui/attachment";
import { Cancel, FileIcon, RefreshCw } from "@/shared/ui/icons";
import type { FileAttachmentEntry } from "./use-file-attachments.ts";
import { formatFileSize } from "./file-attachments.ts";

const STATE = { uploading: "uploading", failed: "error", done: "done" } as const;

export function FileAttachmentChip({
  entry,
  onRetry,
  onRemove,
}: {
  entry: FileAttachmentEntry;
  onRetry?: (key: string) => void;
  onRemove?: (key: string) => void;
}) {
  const percent = entry.size === 0 ? 100 : Math.min(100, Math.round((entry.received / entry.size) * 100));
  const retry = entry.status === "failed" && onRetry !== undefined;
  return (
    <Attachment
      size="xs"
      state={STATE[entry.status]}
      data-status={entry.status}
      data-testid="file-attachment-chip"
      title={entry.error ?? entry.name}
      className="max-w-64"
    >
      <AttachmentMedia>
        <FileIcon aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{entry.name}</AttachmentTitle>
        <AttachmentDescription className="tabular-nums">
          {entry.status === "failed"
            ? "Failed"
            : entry.status === "uploading"
              ? `Uploading · ${percent}%`
              : formatFileSize(entry.size)}
        </AttachmentDescription>
      </AttachmentContent>
      {retry || onRemove !== undefined ? (
        <AttachmentActions>
          {retry ? (
            <AttachmentAction aria-label={`Retry ${entry.name}`} title="Retry upload" onClick={() => onRetry(entry.key)}>
              <RefreshCw aria-hidden="true" />
            </AttachmentAction>
          ) : null}
          {onRemove === undefined ? null : (
            <AttachmentAction aria-label={`Remove ${entry.name}`} title="Remove" onClick={() => onRemove(entry.key)}>
              <Cancel aria-hidden="true" />
            </AttachmentAction>
          )}
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}

/** A sent message's files: names and sizes only, never a preview. */
export function MessageAttachments({
  attachments,
  testId = "message-attachments",
}: {
  attachments: readonly UserAttachment[];
  testId?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid={testId}>
      {attachments.map((file, index) => (
        <Attachment key={`${file.id}:${index}`} size="xs" title={file.name} className="max-w-64">
          <AttachmentMedia>
            <FileIcon aria-hidden="true" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{file.name}</AttachmentTitle>
            <AttachmentDescription className="tabular-nums">{formatFileSize(file.size)}</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ))}
    </div>
  );
}
