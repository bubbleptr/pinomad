// Everything the client sends goes through one path: decode honoring EXIF
// orientation (the manipulator applies it), cap the long side, re-encode
// JPEG — uniform bytes on the wire, and EXIF/GPS metadata gone with the
// original container. Accepts file/photo URIs and `data:` URIs (clipboard).
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { imageProblem, type MessageImage } from "@pinomad/protocol/images.ts";
import { fitWithin } from "./fit.ts";
import type { ImageSource } from "./attachment-store.ts";

const READ_ERROR = "Couldn't read the image";

/** Read `source` down to a send-ready image: long side ≤ 1568px, JPEG 0.85. */
export async function prepareImage(source: ImageSource): Promise<MessageImage> {
  let { width, height } = source;
  if (!width || !height) {
    // The picker sometimes reports 0×0; a no-op pass yields the real size.
    const probed = await manipulateAsync(source.uri, [], { format: SaveFormat.JPEG }).catch(() => {
      throw new Error(READ_ERROR);
    });
    width = probed.width;
    height = probed.height;
  }
  const target = fitWithin(width, height);
  const actions = target.width === width && target.height === height ? [] : [{ resize: target }];
  const result = await manipulateAsync(source.uri, actions, {
    compress: 0.85,
    format: SaveFormat.JPEG,
    base64: true,
  }).catch(() => {
    throw new Error(READ_ERROR);
  });
  if (result.base64 === undefined) throw new Error(READ_ERROR);
  const image: MessageImage = { data: result.base64, mimeType: "image/jpeg" };
  const problem = imageProblem([image]);
  if (problem !== undefined) throw new Error(problem);
  return image;
}
