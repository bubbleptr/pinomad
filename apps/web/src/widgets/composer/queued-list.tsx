import type { QueueItem } from "@pinomad/client/chat.ts";
import { ChatQueuedMessage } from "../../shared/ui/chat/chat-queued-message.tsx";

const TAGS: Record<QueueItem["mode"], string> = {
  steer: "Steer",
  followUp: "Follow-up",
  write: "Write",
};

/** The waiting rows above a busy composer's input (Pace's QueuedMessageList, display-only). */
export function QueuedList({ items }: { items: readonly QueueItem[] }) {
  if (items.length === 0) return null;
  const bodyOf = (item: QueueItem): string => {
    if (item.imageCount === 0) return item.text;
    const suffix = `${item.imageCount} ${item.imageCount === 1 ? "image" : "images"}`;
    return item.text === "" ? suffix : `${item.text} · ${suffix}`;
  };
  return (
    <div className="mx-auto mb-3 grid w-full gap-1.5" data-testid="queued-message-list">
      {items.map((item) => (
        <ChatQueuedMessage key={item.id} body={bodyOf(item)} tag={TAGS[item.mode]} />
      ))}
    </div>
  );
}
