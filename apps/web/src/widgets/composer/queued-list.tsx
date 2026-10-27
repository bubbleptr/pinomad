import { ChatMessageMetadata } from "@astryxdesign/core/Chat";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import type { QueueItem, QueueStatus } from "@pinomad/client/chat.ts";
import { ChatQueuedMessage } from "../../shared/ui/chat/chat-queued-message.tsx";

const TAGS: Record<QueueItem["mode"], string> = {
  steer: "Steer",
  followUp: "Follow-up",
  write: "Write",
};

/** A delivery caption for one queued row: Sent for the host's inbox, the local phase otherwise. */
function QueueStatusView({ status }: { status: QueueStatus }) {
  const mapped = status === "failed" ? "error" : status === "unknown" ? "sending" : status;
  const metadata = <ChatMessageMetadata status={mapped} />;
  if (status !== "unknown") return metadata;
  return (
    <InternationalizationProvider
      locale="en"
      overrides={{ en: { "@astryx.chat.status.sending": "Not confirmed" } }}
    >
      {metadata}
    </InternationalizationProvider>
  );
}

/** The waiting rows above a busy composer's input (Pace's QueuedMessageList). */
export function QueuedList({
  items,
  canAct,
  busy,
  editDisabled,
  editTooltip,
  editRetryId,
  narrow,
  pendingIds,
  pendingRequestIds,
  onSteer,
  onRetry,
  onEdit,
  onWithdraw,
}: {
  items: readonly QueueItem[];
  /** The connection is live and the host has the 5.14 queued-input calls. */
  canAct: boolean;
  /** A run is in flight; Steer only makes sense while one is. */
  busy: boolean;
  /** Edit is unavailable for every row — the composer already holds a draft. */
  editDisabled: boolean;
  editTooltip?: string;
  /** The one retained copy whose row may retry Edit while its outcome is unknown. */
  editRetryId?: number;
  narrow: boolean;
  /** Rows with a request in flight; each row's actions stay disabled until it settles. */
  pendingIds: ReadonlySet<number>;
  /** Local rows with a retry/edit query in flight. */
  pendingRequestIds: ReadonlySet<string>;
  onSteer: (item: QueueItem) => void;
  onRetry: (item: QueueItem) => void;
  onEdit: (item: QueueItem) => void;
  onWithdraw: (item: QueueItem) => void;
}) {
  if (items.length === 0) return null;
  const bodyOf = (item: QueueItem): string => {
    const parts = [
      ...(item.imageCount === 0 ? [] : [`${item.imageCount} ${item.imageCount === 1 ? "image" : "images"}`]),
      ...(item.attachmentCount === 0 ? [] : [`${item.attachmentCount} ${item.attachmentCount === 1 ? "file" : "files"}`]),
    ];
    if (parts.length === 0) return item.text;
    const suffix = parts.join(" · ");
    return item.text === "" ? suffix : `${item.text} · ${suffix}`;
  };
  return (
    <div className="mx-auto mb-3 grid w-full gap-1.5" data-testid="queued-message-list">
      {items.map((item) => {
        const isLocal = item.id === undefined;
        // Writes are protocol-rejected by both calls; only inputs are actionable.
        const actionable = !isLocal && canAct && item.mode !== "write";
        const canRetry = isLocal && (item.status === "unknown" || item.status === "failed");
        // Unknown must be queried first; only a confirmed refusal offers Edit.
        const canEdit = isLocal ? item.status === "failed" : actionable;
        const pending = isLocal
          ? item.requestId !== undefined && pendingRequestIds.has(item.requestId)
          : pendingIds.has(item.id!);
        return (
          <ChatQueuedMessage
            key={isLocal ? `local:${item.requestId}` : item.id}
            data-testid={isLocal ? "local-queued-message" : "chat-queued-message"}
            body={bodyOf(item)}
            tag={TAGS[item.mode]}
            status={<QueueStatusView status={item.status} />}
            isLocal={isLocal}
            narrow={narrow}
            isPending={pending}
            isEditDisabled={canEdit && editDisabled && (isLocal || item.id !== editRetryId)}
            editTooltip={editDisabled ? editTooltip : undefined}
            onSteer={actionable && item.mode === "followUp" && busy ? () => onSteer(item) : undefined}
            onRetry={canRetry ? () => onRetry(item) : undefined}
            onEdit={canEdit ? () => onEdit(item) : undefined}
            onWithdraw={actionable ? () => onWithdraw(item) : undefined}
          />
        );
      })}
    </div>
  );
}
