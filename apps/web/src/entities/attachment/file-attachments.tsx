// File chips in the composer and in a sent bubble (issue #321). One visual
// language with image thumbnails: same gap, same compact size, token colors
// from the theme — no hardcoded color.
import type { UserAttachment } from "@pinomad/protocol/attachments.ts";
import { Cancel, FileIcon, RefreshCw } from "@/shared/ui/icons";
import type { FileAttachmentEntry } from "./use-file-attachments.ts";
import { formatFileSize } from "./file-attachments.ts";

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
  return (
    <div
      className="file-chip"
      data-status={entry.status}
      data-testid="file-attachment-chip"
      title={entry.error ?? entry.name}
    >
      <FileIcon aria-hidden="true" className="file-chip__icon" />
      <span className="file-chip__name">{entry.name}</span>
      <span className="file-chip__size">
        {entry.status === "failed" ? "Failed" : entry.status === "uploading" ? `${percent}%` : formatFileSize(entry.size)}
      </span>
      {entry.status === "failed" && onRetry !== undefined ? (
        <button
          type="button"
          className="file-chip__action"
          aria-label={`Retry ${entry.name}`}
          title="Retry upload"
          onClick={() => onRetry(entry.key)}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      ) : null}
      {onRemove === undefined ? null : (
        <button
          type="button"
          className="file-chip__action"
          aria-label={`Remove ${entry.name}`}
          title="Remove"
          onClick={() => onRemove(entry.key)}
        >
          <Cancel aria-hidden="true" />
        </button>
      )}
      {entry.status === "uploading" ? (
        <span className="file-chip__bar" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </div>
  );
}

/** A sent message's files: names and sizes only, never a preview. */
export function MessageAttachments({ attachments }: { attachments: readonly UserAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid="message-attachments">
      {attachments.map((file, index) => (
        <div key={`${file.id}:${index}`} className="file-chip" data-status="done" title={file.name}>
          <FileIcon aria-hidden="true" className="file-chip__icon" />
          <span className="file-chip__name">{file.name}</span>
          <span className="file-chip__size">{formatFileSize(file.size)}</span>
        </div>
      ))}
    </div>
  );
}
