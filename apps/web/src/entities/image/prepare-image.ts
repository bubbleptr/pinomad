// Everything the client sends goes through one path: decode honoring EXIF
// orientation, cap the long side, re-encode JPEG — uniform bytes on the wire,
// and EXIF/GPS metadata gone with the original container.
import { imageProblem, type MessageImage } from "@pinomad/protocol/images.ts";

const MAX_SIDE = 1568;

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // String.fromCharCode spread chokes on whole megabyte arrays; chunk it.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Read `file` down to a send-ready image: long side ≤ 1568px, JPEG 0.85. */
export async function prepareImage(file: File): Promise<MessageImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`Couldn't read ${file.name}`);
  }
  // Never upscale.
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  // JPEG has no alpha; white keeps transparent art from turning black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result === null ? reject(new Error(`Couldn't read ${file.name}`)) : resolve(result)),
      "image/jpeg",
      0.85,
    ),
  );
  const image: MessageImage = { data: base64Of(await blob.arrayBuffer()), mimeType: "image/jpeg" };
  const problem = imageProblem([image]);
  if (problem !== undefined) throw new Error(problem);
  return image;
}
