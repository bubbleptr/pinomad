import type { QueueItem } from "../../presentation/chat.ts";
import { ChatQueuedMessage } from "../../shared/ui/chat/chat-queued-message.tsx";

const TAGS: Record<QueueItem["mode"], string> = {
  steer: "Steer",
  followUp: "Follow-up",
  write: "Write",
};

/** The waiting rows above a busy composer's input (Pace's QueuedMessageList, display-only). */
export function QueuedList({ items }: { items: readonly QueueItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mx-auto mb-3 grid w-full gap-1.5" data-testid="queued-message-list">
      {items.map((item) => (
        <ChatQueuedMessage key={item.id} body={item.text} tag={TAGS[item.mode]} />
      ))}
    </div>
  );
}
