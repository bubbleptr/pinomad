// A queued message above a busy composer, drawn as a card: a drag handle on
// the left, icon actions that wait for hover, and one column on the right for
// the steer mark. Steer, Edit, and Withdraw are the protocol's 5.14 queued-input
// calls; reordering is 5.29's reorderQueued.
import { IconButton } from "@astryxdesign/core/IconButton";
import type { ComponentProps, FocusEvent, KeyboardEvent, ReactNode, Ref } from "react";
import { ArrowBigUpDash, Cancel, GripVertical, Pencil, RefreshCw } from "../icons.tsx";

type ChatQueuedMessageOwnProps = {
  body: string;
  /** Follow-up is the default and gets no mark; a steer shows ⇪ in the right column. */
  mode: "steer" | "followUp" | "write";
  /** No hover on a phone: actions stay visible. */
  narrow?: boolean;
  /** Disable this row's actions while one of its requests is in flight. */
  isPending?: boolean;
  /** Disable Edit on its own — the composer already holds a draft. */
  isEditDisabled?: boolean;
  editTooltip?: string;
  /** A local send that needs the user ("Not confirmed", "Failed to send"); host rows have none. */
  status?: ReactNode;
  /** A local row the host has not admitted yet: its text stays muted. */
  isLocal?: boolean;
  /** Present when the row can move; the handle answers ↑/↓ and starts a drag. */
  reorder?: {
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    /** Arms the row's native drag from a press on the handle only. */
    onHandlePointerDown?: () => void;
    handleRef?: Ref<HTMLButtonElement>;
    onHandleBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
  };
  /** The row being dragged, or the side a drop would land on. */
  dragState?: "dragging" | "before" | "after";
  /** Omit each action when it is unavailable in the current state. */
  onSteer?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onWithdraw?: () => void;
};

export type ChatQueuedMessageProps = Omit<ComponentProps<"div">, keyof ChatQueuedMessageOwnProps | "children"> &
  ChatQueuedMessageOwnProps;

export function ChatQueuedMessage({
  body,
  mode,
  narrow = false,
  isPending = false,
  isEditDisabled = false,
  editTooltip,
  status,
  isLocal = false,
  reorder,
  dragState,
  onSteer,
  onRetry,
  onEdit,
  onWithdraw,
  className,
  ...rest
}: ChatQueuedMessageProps) {
  // Actions wait for hover or focus on pointer devices.
  const reveal = narrow ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
  const onHandleKey = (event: KeyboardEvent) => {
    const move = event.key === "ArrowUp" ? reorder?.onMoveUp : event.key === "ArrowDown" ? reorder?.onMoveDown : undefined;
    if (move === undefined) return;
    event.preventDefault();
    move();
  };
  const actions = [
    onRetry === undefined ? null : (
      <IconButton
        key="retry"
        label="Retry this message"
        tooltip="Retry"
        variant="ghost"
        size="sm"
        isDisabled={isPending}
        onClick={onRetry}
        icon={<RefreshCw aria-hidden="true" />}
      />
    ),
    onEdit === undefined ? null : (
      <IconButton
        key="edit"
        label={isLocal ? "Edit this message" : "Edit queued message"}
        tooltip={isEditDisabled && editTooltip !== undefined ? editTooltip : "Edit"}
        variant="ghost"
        size="sm"
        isDisabled={isPending || isEditDisabled}
        onClick={onEdit}
        icon={<Pencil aria-hidden="true" />}
      />
    ),
    onWithdraw === undefined ? null : (
      <IconButton
        key="withdraw"
        label="Withdraw queued message"
        tooltip="Withdraw"
        variant="ghost"
        size="sm"
        isDisabled={isPending}
        onClick={onWithdraw}
        icon={<Cancel aria-hidden="true" />}
      />
    ),
  ].filter((action) => action !== null);
  return (
    <div
      className={`chat-queued-message group flex min-h-10 min-w-0 items-center gap-1 rounded-lg border border-border bg-background p-1 text-sm ${
        className ?? ""
      }`.trim()}
      data-testid="chat-queued-message"
      data-local={isLocal ? "" : undefined}
      data-dragging={dragState === "dragging" ? "" : undefined}
      data-drop-target={dragState === "before" || dragState === "after" ? dragState : undefined}
      {...rest}
    >
      {reorder === undefined ? (
        <span className="w-6 shrink-0" />
      ) : (
        <button
          ref={reorder.handleRef}
          type="button"
          className="chat-queued-message__handle flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground active:cursor-grabbing"
          aria-label="Reorder queued message"
          aria-description="Drag, or press the up and down arrow keys"
          title="Drag to reorder"
          // Not disabled while a move is in flight: that would drop focus
          // between two arrow presses. The list ignores a move until it settles.
          onKeyDown={onHandleKey}
          onPointerDown={reorder.onHandlePointerDown}
          onBlur={reorder.onHandleBlur}
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      )}
      <p
        className="chat-queued-message__body min-w-0 flex-1 truncate"
        data-slot="queued-message-body"
        title={body}
      >
        {body}
      </p>
      {status === undefined ? null : (
        <span className="shrink-0 text-xs leading-4" data-slot="queued-message-status">
          {status}
        </span>
      )}
      {actions.length === 0 ? null : (
        // A local row's Retry is the reason it is shown, so it never hides.
        <span className={`flex shrink-0 items-center gap-1 transition-opacity ${isLocal ? "" : reveal}`}>{actions}</span>
      )}
      {isLocal ? null : (
        // One column for the steer mark: on a follow-up the same spot holds
        // Steer now, so pressing it leaves the mark where the button was.
        <span
          className="flex w-7 shrink-0 items-center justify-center text-muted-foreground"
          data-slot="queued-message-mode"
          data-mode={mode}
        >
          {mode === "steer" ? (
            <span title="Steer: lands at the next boundary in this run" role="img" aria-label="Steer">
              <ArrowBigUpDash aria-hidden="true" className="size-4" />
            </span>
          ) : onSteer === undefined ? null : (
            <span className={`flex transition-opacity ${reveal}`}>
              <IconButton
                label="Steer the run with this message"
                tooltip="Steer now"
                variant="ghost"
                size="sm"
                isDisabled={isPending}
                onClick={onSteer}
                icon={<ArrowBigUpDash aria-hidden="true" />}
              />
            </span>
          )}
        </span>
      )}
    </div>
  );
}
