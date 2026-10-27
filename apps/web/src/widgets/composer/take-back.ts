import type { ConversationId } from "@earendil-works/pi-durable";
import type { LogicalSubmission, SubmissionDraft } from "@pinomad/protocol/view.ts";

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

/**
 * The side composer only holds text and skill picks. Taking back an image or
 * file send there would drop it, so those rows stay put and direct the user to
 * the main composer.
 */
export function canTakeBackInSidePanel(
  submission: Pick<LogicalSubmission, "images" | "attachments"> | undefined,
  disabled: boolean,
): boolean {
  return !disabled
    && submission !== undefined
    && submission.images.length === 0
    && submission.attachments.length === 0;
}
