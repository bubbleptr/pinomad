import type { MessageImage } from "@pinomad/protocol/images.ts";

/** The data URL a `MessageImage` renders as. */
export const imageSrc = (image: MessageImage): string => `data:${image.mimeType};base64,${image.data}`;
