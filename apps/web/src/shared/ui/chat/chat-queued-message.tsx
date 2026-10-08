// Display-only port of Pace's shared/ui/chat/chat-queued-message.tsx (PiGUI
// commit 15b9084): the queued follow-up row. Withdraw/reorder/steer actions
// are dropped — the protocol has no such calls — so a static mode tag takes
// their place.
import type { ComponentProps } from "react";

type ChatQueuedMessageOwnProps = {
  body: string;
  /** The queue mode tag: "Steer" / "Follow-up" / "Write". */
  tag: string;
};

export type ChatQueuedMessageProps = Omit<
  ComponentProps<"div">,
  keyof ChatQueuedMessageOwnProps | "children"
> &
  ChatQueuedMessageOwnProps;

export function ChatQueuedMessage({ body, tag, className, ...rest }: ChatQueuedMessageProps) {
  return (
    <div
      className={`chat-queued-message flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pl-3 pr-2 text-sm ${
        className ?? ""
      }`.trim()}
      data-testid="chat-queued-message"
      {...rest}
    >
      <p className="chat-queued-message__body min-w-0 flex-1 truncate" data-slot="queued-message-body" title={body}>
        {body}
      </p>
      <span className="shrink-0 text-xs font-medium text-muted">{tag}</span>
    </div>
  );
}
