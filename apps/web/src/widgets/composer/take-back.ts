import type { ConversationId } from "@earendil-works/pi-durable";
import type { SubmissionDraft } from "@pinomad/protocol/view.ts";

/** A transcript take-back waiting for its own conversation's composer. */
export interface PendingTakeBack {
  readonly conversationId: ConversationId;
  readonly draft: SubmissionDraft;
}

/**
 * The draft only belongs to the conversation it was taken from. While the user
 * is elsewhere it stays pending; a new chat or another conversation must not
 * receive it.
 */
export function takeBackForConversation(
  pending: PendingTakeBack | undefined,
  conversationId: ConversationId | undefined,
): SubmissionDraft | undefined {
  return pending !== undefined && pending.conversationId === conversationId ? pending.draft : undefined;
}
