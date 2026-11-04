import type { QueueItem } from "@pinomad/client/chat.ts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { flushSync } from "react-dom";
import { ChatQueuedMessage } from "../../shared/ui/chat/chat-queued-message.tsx";

type Side = "before" | "after";

/**
 * The `before` argument of reorderQueued that lands `moved` on `side` of
 * `target`: the target itself, or the next queued input after it (absent at
 * the end). Writes are skipped — the host refuses one as `before`.
 */
export function reorderBefore(items: readonly QueueItem[], moved: number, target: number, side: Side): number | undefined {
  if (side === "before") return target;
  const inputs = items.filter((item) => item.id !== undefined && item.id !== moved && item.mode !== "write");
  const at = inputs.findIndex((item) => item.id === target);
  return inputs[at + 1]?.id;
}

const keyOf = (item: QueueItem): string => (item.id === undefined ? `local:${item.requestId}` : String(item.id));

/**
 * Slide the cards to their new places when the inbox only changed order: the
 * old order renders once more, then a View Transition swaps in the new one and
 * the browser animates each named card between the two. Anything else (rows
 * added or removed), reduced motion, a hidden page, or no API just renders.
 */
function useReorderTransition(items: readonly QueueItem[]): readonly QueueItem[] {
  const committed = useRef<readonly string[]>([]);
  const [released, setReleased] = useState<string>();
  const order = items.map(keyOf);
  const signature = order.join(" ");
  const previous = committed.current;
  const reordered =
    previous.length === order.length &&
    previous.join(" ") !== signature &&
    order.every((key) => previous.includes(key));
  const animate =
    reordered &&
    released !== signature &&
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    document.visibilityState === "visible" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const shown = animate ? previous.map((key) => items.find((item) => keyOf(item) === key)!) : items;
  // The update callback runs a frame later; a render in between must not
  // start a second transition for the same order.
  const starting = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!animate) {
      committed.current = order;
      return;
    }
    if (starting.current === signature) return;
    starting.current = signature;
    const transition = document.startViewTransition(() => {
      flushSync(() => setReleased(signature));
      committed.current = order;
    });
    // A skipped transition still runs its update; clear the guard either way.
    void transition.finished.finally(() => {
      if (starting.current === signature) starting.current = undefined;
    });
  });
  return shown;
}

/** A delivery caption for a local row; a host row needs none, it is in the inbox. */
function localCaption(status: QueueItem["status"]) {
  if (status === "unknown") return <span className="text-muted">Not confirmed</span>;
  if (status === "failed") return <span className="text-danger">Failed to send</span>;
  return undefined;
}

/** The waiting rows above a busy composer's input. */
export function QueuedList({
  items,
  canAct,
  canReorder,
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
  onReorder,
}: {
  items: readonly QueueItem[];
  /** The connection is live and the host has the 5.14 queued-input calls. */
  canAct: boolean;
  /** The connection is live and the host has 5.28's reorderQueued. */
  canReorder: boolean;
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
  /** Move `item` so it sits right before the queued input `before` (absent: last). */
  onReorder: (item: QueueItem, before: number | undefined) => void;
}) {
  type Drag = { id: number; over?: number; side?: Side };
  const [drag, setDragState] = useState<Drag>();
  // Handlers read the ref: the first dragover can arrive before React has
  // rendered the dragstart, and an unaccepted dragover cancels the drop.
  const dragRef = useRef<Drag | undefined>(undefined);
  const setDrag = (next: Drag | undefined) => {
    dragRef.current = next;
    setDragState(next);
  };
  const [armed, setArmed] = useState<number>();
  const shown = useReorderTransition(items);
  // view-transition-name is page-global: scope it to this list.
  const scope = useId().replace(/[^a-zA-Z0-9]/g, "");
  // The handle that last moved by keyboard: React may re-insert its row when
  // the inbox reorders, which blurs it, so focus is put back afterwards.
  const keyboardFocus = useRef<number | undefined>(undefined);
  const handles = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    const id = keyboardFocus.current;
    if (id === undefined) return;
    const handle = handles.current.get(id);
    if (handle !== undefined && (document.activeElement === null || document.activeElement === document.body)) {
      handle.focus();
    }
    // One restore per move: every arrow press sets it again.
    if (handle === undefined || document.activeElement === handle) keyboardFocus.current = undefined;
  }, [shown]);
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
  // A row moves only among host inputs of its own mode: a steer lands at the
  // next boundary and a follow-up after the run, so crossing them would show
  // an order the host does not deliver.
  const movable = (item: QueueItem): boolean => canAct && canReorder && item.id !== undefined && item.mode !== "write";
  const peersOf = (item: QueueItem) => items.filter((peer) => movable(peer) && peer.mode === item.mode);
  const draggedItem = () => items.find((item) => item.id === dragRef.current?.id);

  return (
    <div className="mx-auto mb-3 grid w-full gap-1.5" data-testid="queued-message-list">
      {shown.map((item) => {
        const isLocal = item.id === undefined;
        // Writes are protocol-rejected by both calls; only inputs are actionable.
        const actionable = !isLocal && canAct && item.mode !== "write";
        const canRetry = isLocal && (item.status === "unknown" || item.status === "failed");
        // Unknown must be queried first; only a confirmed refusal offers Edit.
        const canEdit = isLocal ? item.status === "failed" : actionable;
        const pending = isLocal
          ? item.requestId !== undefined && pendingRequestIds.has(item.requestId)
          : pendingIds.has(item.id!);
        const id = item.id;
        const peers = peersOf(item);
        const index = peers.findIndex((peer) => peer.id === id);
        const moveTo = (target: QueueItem | undefined, side: Side) => {
          if (id === undefined || target?.id === undefined) return undefined;
          return () => {
            keyboardFocus.current = id;
            onReorder(item, reorderBefore(items, id, target.id!, side));
          };
        };
        return (
          <ChatQueuedMessage
            key={isLocal ? `local:${item.requestId}` : id}
            data-testid={isLocal ? "local-queued-message" : "chat-queued-message"}
            style={
              {
                viewTransitionName: `queued-${scope}-${keyOf(item).replace(/[^a-zA-Z0-9-]/g, "")}`,
                viewTransitionClass: "queued-card",
              } as CSSProperties
            }
            body={bodyOf(item)}
            mode={item.mode}
            status={isLocal ? localCaption(item.status) : undefined}
            isLocal={isLocal}
            narrow={narrow}
            isPending={pending}
            isEditDisabled={canEdit && editDisabled && (isLocal || id !== editRetryId)}
            editTooltip={editDisabled ? editTooltip : undefined}
            reorder={
              movable(item) && id !== undefined
                ? {
                    onMoveUp: moveTo(peers[index - 1], "before"),
                    onMoveDown: moveTo(peers[index + 1], "after"),
                    onHandlePointerDown: () => setArmed(id),
                    handleRef: (handle) => {
                      if (handle === null) handles.current.delete(id);
                      else handles.current.set(id, handle);
                    },
                    onHandleBlur: (event) => {
                      // A blur with somewhere to go is the user leaving; one
                      // to nowhere is the row being re-inserted.
                      if (event.relatedTarget !== null) keyboardFocus.current = undefined;
                    },
                  }
                : undefined
            }
            dragState={
              id === undefined || drag === undefined ? undefined : drag.id === id ? "dragging" : drag.over === id ? drag.side : undefined
            }
            // Only a press on the handle arms the native drag, so text and
            // buttons in the row keep their own pointer behaviour.
            draggable={armed !== undefined && armed === id}
            onPointerUp={() => setArmed(undefined)}
            onPointerCancel={() => setArmed(undefined)}
            onDragStart={(event: DragEvent) => {
              // A drag of selected body text bubbles here too; only a press
              // on this row's handle starts a reorder, the rest stay text drags.
              if (id === undefined || armed !== id || !movable(item)) return;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.text);
              setDrag({ id });
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              const dragged = draggedItem();
              if (dragged?.id === undefined || id === undefined || dragged.id === id) return;
              if (dragged.mode !== item.mode || !movable(item)) return;
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              const side = event.clientY < box.top + box.height / 2 ? "before" : "after";
              const current = dragRef.current;
              if (current?.over !== id || current.side !== side) setDrag({ id: dragged.id, over: id, side });
            }}
            onDrop={(event: DragEvent) => {
              event.preventDefault();
              const dragged = draggedItem();
              const current = dragRef.current;
              if (dragged?.id !== undefined && current?.over !== undefined && current.side !== undefined) {
                onReorder(dragged, reorderBefore(items, dragged.id, current.over, current.side));
              }
              setDrag(undefined);
              setArmed(undefined);
            }}
            onDragEnd={() => {
              setDrag(undefined);
              setArmed(undefined);
            }}
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
