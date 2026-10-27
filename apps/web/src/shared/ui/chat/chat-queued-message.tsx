// Port of Pace's shared/ui/chat/chat-queued-message.tsx (PiGUI commit
// 15b9084), minus the settlement states, drag reordering, and presence
// motion: the host's inbox update removes a row or changes its tag instead.
// Steer, Edit, and Withdraw are the protocol's 5.14 queued-input calls.
import { Button } from "@astryxdesign/core/Button";
import type { ComponentProps, ReactNode } from "react";

type ChatQueuedMessageOwnProps = {
  body: string;
  /** The queue mode tag: "Steer" / "Follow-up" / "Write". */
  tag: string;
  /** Put the actions on their own line — three labels do not fit a phone row. */
  narrow?: boolean;
  /** Disable this row's actions while one of its requests is in flight. */
  isPending?: boolean;
  /** Disable Edit on its own — the composer already holds a draft. */
  isEditDisabled?: boolean;
  editTooltip?: string;
  /** Delivery state beside the tag; host rows say Sent, local rows their send phase. */
  status?: ReactNode;
  /** A local row: Retry replaces Steer/Withdraw, and Edit withdraws then refills. */
  isLocal?: boolean;
  /** Omit each action when it is unavailable in the current state. */
  onSteer?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onWithdraw?: () => void;
};

export type ChatQueuedMessageProps = Omit<
  ComponentProps<"div">,
  keyof ChatQueuedMessageOwnProps | "children"
> &
  ChatQueuedMessageOwnProps;

export function ChatQueuedMessage({
  body,
  tag,
  narrow = false,
  isPending = false,
  isEditDisabled = false,
  editTooltip,
  status,
  isLocal = false,
  onSteer,
  onRetry,
  onEdit,
  onWithdraw,
  className,
  ...rest
}: ChatQueuedMessageProps) {
  return (
    <div
      className={`chat-queued-message flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pl-3 pr-2 text-sm ${
        narrow ? "flex-wrap" : ""
      } ${className ?? ""}`.trim()}
      data-testid="chat-queued-message"
      {...rest}
    >
      <p className="chat-queued-message__body min-w-0 flex-1 truncate" data-slot="queued-message-body" title={body}>
        {body}
      </p>
      {status === undefined ? null : (
        <span className="shrink-0" data-slot="queued-message-status">
          {status}
        </span>
      )}
      <span className="shrink-0 text-xs font-medium text-muted" data-slot="queued-message-tag">
        {tag}
      </span>
      {onSteer === undefined && onRetry === undefined && onEdit === undefined && onWithdraw === undefined ? null : (
        <div className={`flex shrink-0 items-center gap-1${narrow ? " w-full justify-end" : ""}`}>
          {onSteer === undefined ? null : (
            <Button
              label="Steer the run with this message"
              variant="secondary"
              size="sm"
              isDisabled={isPending}
              onClick={onSteer}
            >
              Steer
            </Button>
          )}
          {onRetry === undefined ? null : (
            <Button
              label="Retry this message"
              variant="secondary"
              size="sm"
              isDisabled={isPending}
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
          {onEdit === undefined ? null : (
            <Button
              label={isLocal ? "Edit this message" : "Edit queued message"}
              variant="ghost"
              size="sm"
              isDisabled={isPending || isEditDisabled}
              tooltip={isEditDisabled ? editTooltip : undefined}
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
          {onWithdraw === undefined ? null : (
            <Button
              label="Withdraw queued message"
              variant="ghost"
              size="sm"
              isDisabled={isPending}
              onClick={onWithdraw}
            >
              Withdraw
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
