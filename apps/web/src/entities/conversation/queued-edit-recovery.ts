// A queue edit can outlive its composer: the image round-trip finishes after
// focus moved to another host, while the destructive withdraw still lands.
// Keep the recovered draft per host+conversation until the next composer mount.
import type { UserAttachment } from "@pinomad/protocol/attachments.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { MessageImage } from "@pinomad/protocol/images.ts";

export interface QueuedEditRecovery {
  readonly text: string;
  readonly skills: readonly string[];
  readonly images: readonly MessageImage[];
  readonly attachments: readonly UserAttachment[];
}

const recoveries = new Map<string, QueuedEditRecovery>();

const keyOf = (source: string | undefined, conversationId: ConversationId): string =>
  `${source ?? ""}\u0000${conversationId}`;

export function saveQueuedEditRecovery(
  source: string | undefined,
  conversationId: ConversationId,
  recovery: QueuedEditRecovery,
): void {
  recoveries.set(keyOf(source, conversationId), recovery);
}

/** Read and consume one recovery; the composer owning it is the only reader. */
export function takeQueuedEditRecovery(
  source: string | undefined,
  conversationId: ConversationId,
): QueuedEditRecovery | undefined {
  const key = keyOf(source, conversationId);
  const recovery = recoveries.get(key);
  if (recovery !== undefined) recoveries.delete(key);
  return recovery;
}

export function clearQueuedEditRecovery(source: string | undefined, conversationId: ConversationId): void {
  recoveries.delete(keyOf(source, conversationId));
}
