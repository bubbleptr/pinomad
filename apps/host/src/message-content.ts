// Builds the user-input content the harness stores: a bare string when there
// are no blocks (unchanged from before images existed), a block list otherwise.
import type { UserInput } from "@earendil-works/pi-durable";
import type { MessageImage } from "@pinomad/protocol/images.ts";

/**
 * `text` alone stays a string; with attachments or images the message is a
 * block list: the user text (omitted when empty), the attachments block, then
 * the image blocks (issue #321).
 */
export function messageContent(
  text: string,
  images?: readonly MessageImage[],
  attachmentText?: string,
): UserInput {
  if ((images === undefined || images.length === 0) && attachmentText === undefined) return text;
  return [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...(attachmentText === undefined ? [] : [{ type: "text" as const, text: attachmentText }]),
    ...(images ?? []).map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
  ];
}
