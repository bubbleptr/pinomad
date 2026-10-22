// Message images travel inside submit/createConversation args as base64
// content. This module runs on every client — no Buffer, no Node-only APIs —
// sizes are computed from the base64 length, never decoded.

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** One attached image: base64 bytes (no `data:` prefix) and its type. */
export type MessageImage = { readonly data: string; readonly mimeType: ImageMimeType };

/**
 * An image named by its content (5.15, ADR-0027): a conversation stream
 * subscribed with `images: "ref"` carries image blocks as
 * `{ type: "image", mimeType, ref }`, and the `image` call returns the bytes.
 * `ref` is opaque to clients; equal refs are equal images, so a client may
 * cache bytes by ref for as long as it likes.
 */
export type ImageRef = { readonly ref: string; readonly mimeType: ImageMimeType };

/** What submit/createConversation attach: bytes, or a ref the connection was shown (5.15). */
export type OutgoingImage = MessageImage | ImageRef;

export const MAX_IMAGES_PER_MESSAGE = 4;
/** Decoded bytes — base64 inflates by 4/3, so the wire string is larger. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Why a message's images can't be admitted, or undefined when they can.
 * Shared: the host enforces the verdict, clients may pre-check.
 */
export function imageProblem(images: readonly { data: string; mimeType: string }[]): string | undefined {
  if (images.length > MAX_IMAGES_PER_MESSAGE) return `At most ${MAX_IMAGES_PER_MESSAGE} images per message`;
  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    if (!(IMAGE_MIME_TYPES as readonly string[]).includes(image.mimeType)) {
      return `Unsupported image type: ${image.mimeType} (use JPEG, PNG, GIF or WebP)`;
    }
    if (image.data === "" || image.data.length % 4 !== 0 || !BASE64.test(image.data)) {
      return `Image ${i + 1} is not valid base64`;
    }
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    if ((image.data.length * 3) / 4 - padding > MAX_IMAGE_BYTES) return `Image ${i + 1} is larger than 5 MB`;
  }
  return undefined;
}
