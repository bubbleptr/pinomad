// `read` returns image files as image blocks; a configured processor shrinks
// them to the model's limits instead of refusing the file.
import { deflateSync, crc32 } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createCoding } from "../src/extensions/coding.ts";
import { connectTo, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

/** A solid-colour PNG, written without an image library. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const name = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([head, name, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const idat = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Width and height of a PNG (IHDR) or JPEG (first SOF marker). */
function imageSize(bytes: Buffer): { width: number; height: number } {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error("unrecognized image data");
}

describe("read images", () => {
  it("returns a PNG bigger than the model's limits resized to fit", async () => {
    const project = await tempDir();
    defer(project.remove);
    await writeFile(join(project.path, "big.png"), solidPng(3000, 1000, [200, 40, 40]));
    // No worker thread under vitest: Photon runs inline here.
    const images = await createNodePhotonImages({ worker: false });
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: () => [createCoding({ images })],
      answers: [
        fauxAssistantMessage(fauxToolCall("read", { path: "big.png" }), { stopReason: "toolUse" }),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "look at the png");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = client.view
      .current()
      .conversation!.entries.filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => entry.model?.[0] as { content?: { type: string; data?: string; mimeType?: string }[]; isError?: boolean })
      .at(-1);
    expect(result?.isError).not.toBe(true);
    const image = result?.content?.find((block) => block.type === "image");
    expect(image?.mimeType).toMatch(/^image\//);
    const size = imageSize(Buffer.from(image?.data ?? "", "base64"));
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2000);
    // The long side is used fully: 3000x1000 becomes 2000 wide, not smaller.
    expect(Math.max(size.width, size.height)).toBeGreaterThanOrEqual(1500);
  });
});
