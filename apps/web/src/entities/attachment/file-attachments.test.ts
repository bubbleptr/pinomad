import { describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@pinomad/protocol/attachments.ts";
import {
  UploadCancelled,
  attachmentRoom,
  bytesToBase64,
  fileProblem,
  formatFileSize,
  splitFiles,
  uploadAttachment,
} from "./file-attachments.ts";

const fakeFile = (name: string, bytes: Uint8Array, type = "application/octet-stream") =>
  ({
    name,
    type,
    size: bytes.length,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  }) as unknown as File;

describe("file attachment helpers", () => {
  it("splits image MIME files to the image path and the rest to uploads", () => {
    const image = fakeFile("a.png", new Uint8Array([1]), "image/png");
    const log = fakeFile("a.log", new Uint8Array([1]));
    expect(splitFiles([image, log])).toEqual({ images: [image], others: [log] });
  });

  it("formats sizes compactly", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(12 * 1024)).toBe("12 KB");
    expect(formatFileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });

  it("encodes bytes as base64 in chunks", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
    expect(Buffer.from(bytesToBase64(bytes), "base64")).toEqual(Buffer.from(bytes));
  });

  it("pre-checks the host's count and size limits", () => {
    expect(attachmentRoom(0)).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(attachmentRoom(MAX_ATTACHMENTS_PER_MESSAGE + 2)).toBe(0);
    expect(fileProblem(fakeFile("ok.txt", new Uint8Array(1)))).toBeUndefined();
    expect(fileProblem(fakeFile("huge.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1)))).toMatch(/10 MB/);
  });

  it("uploads one chunk at a time and resumes from the host's received", async () => {
    const begin = vi.fn(async () => "A".repeat(22));
    const offsets: number[] = [];
    const append = vi.fn(async (_id: string, offset: number, data: string) => {
      offsets.push(offset);
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      const received = offset + (data.length * 3) / 4 - padding;
      return { received, complete: received === 700_000 };
    });
    const file = fakeFile("big.bin", new Uint8Array(700_000));
    const progress = vi.fn();
    const result = await uploadAttachment({ beginAttachment: begin, appendAttachment: append } as never, file, { received: 0 }, {
      onId: () => {},
      onProgress: progress,
      isCancelled: () => false,
    });
    expect(result).toEqual({ attachmentId: "A".repeat(22), received: 700_000 });
    expect(offsets).toEqual([0, 512 * 1024]);
    expect(progress).toHaveBeenLastCalledWith(700_000, true);
  });

  it("retries with the last known id and offset without calling begin again", async () => {
    const begin = vi.fn(async () => "should not be called");
    const offsets: number[] = [];
    const append = vi.fn(async (_id: string, offset: number, data: string) => {
      offsets.push(offset);
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      const received = offset + (data.length * 3) / 4 - padding;
      return { received, complete: received === 5 };
    });
    await uploadAttachment(
      { beginAttachment: begin, appendAttachment: append } as never,
      fakeFile("five.txt", new Uint8Array(5)),
      { attachmentId: "B".repeat(22), received: 3 },
      { onId: () => {}, onProgress: () => {}, isCancelled: () => false },
    );
    expect(begin).not.toHaveBeenCalled();
    expect(offsets).toEqual([3]);
  });

  it("completes a zero-byte file at begin", async () => {
    const append = vi.fn();
    const onProgress = vi.fn();
    const result = await uploadAttachment(
      { beginAttachment: async () => "C".repeat(22), appendAttachment: append } as never,
      fakeFile("empty.txt", new Uint8Array(0)),
      { received: 0 },
      { onId: () => {}, onProgress, isCancelled: () => false },
    );
    expect(result.received).toBe(0);
    expect(append).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith(0, true);
  });

  it("stops between chunks when the chip is removed", async () => {
    let cancelled = false;
    const append = vi.fn(async (_id: string, offset: number, data: string) => {
      cancelled = true;
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      const received = offset + (data.length * 3) / 4 - padding;
      return { received, complete: false };
    });
    await expect(
      uploadAttachment(
        { beginAttachment: async () => "D".repeat(22), appendAttachment: append } as never,
        fakeFile("big.bin", new Uint8Array(700_000)),
        { received: 0 },
        { onId: () => {}, onProgress: () => {}, isCancelled: () => cancelled },
      ),
    ).rejects.toBeInstanceOf(UploadCancelled);
    expect(append).toHaveBeenCalledTimes(1);
  });
});
