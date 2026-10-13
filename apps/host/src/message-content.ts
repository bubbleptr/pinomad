// Builds the user-input content the harness stores: a bare string when there
// are no images (unchanged from before images existed), a block list otherwise.
import type { UserInput } from "@earendil-works/pi-durable";
import type { MessageImage } from "@pinomad/protocol/images.ts";

/** `text` alone stays a string; with images the message is text block + image blocks. */
export function messageContent(text: string, images?: readonly MessageImage[]): UserInput {
  if (images === undefined || images.length === 0) return text;
  return [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
  ];
}
