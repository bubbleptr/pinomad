import type { QueueItem } from "@pinomad/client/chat.ts";
import { ChatQueuedMessage } from "../../shared/ui/chat/chat-queued-message.tsx";

const TAGS: Record<QueueItem["mode"], string> = {
  steer: "Steer",
  followUp: "Follow-up",
  write: "Write",
};

/** The waiting rows above a busy composer's input (Pace's QueuedMessageList). */
export function QueuedList({
  items,
  canAct,
  busy,
  editDisabled,
  editTooltip,
  narrow,
  pendingIds,
  onSteer,
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
  narrow: boolean;
  /** Rows with a request in flight; each row's actions stay disabled until it settles. */
  pendingIds: ReadonlySet<number>;
  onSteer: (item: QueueItem) => void;
  onEdit: (item: QueueItem) => void;
  onWithdraw: (item: QueueItem) => void;
}) {
  if (items.length === 0) return null;
  const bodyOf = (item: QueueItem): string => {
    if (item.imageCount === 0) return item.text;
    const suffix = `${item.imageCount} ${item.imageCount === 1 ? "image" : "images"}`;
    return item.text === "" ? suffix : `${item.text} · ${suffix}`;
  };
  return (
    <div className="mx-auto mb-3 grid w-full gap-1.5" data-testid="queued-message-list">
      {items.map((item) => {
        // Writes are protocol-rejected by both calls; only inputs are actionable.
        const actionable = canAct && item.mode !== "write";
        return (
          <ChatQueuedMessage
            key={item.id}
            body={bodyOf(item)}
            tag={TAGS[item.mode]}
            narrow={narrow}
            isPending={pendingIds.has(item.id)}
            isEditDisabled={actionable && editDisabled}
            editTooltip={editDisabled ? editTooltip : undefined}
            onSteer={actionable && item.mode === "followUp" && busy ? () => onSteer(item) : undefined}
            onEdit={actionable ? () => onEdit(item) : undefined}
            onWithdraw={actionable ? () => onWithdraw(item) : undefined}
          />
        );
      })}
    </div>
  );
}
